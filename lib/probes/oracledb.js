'use strict'

const WeakMap = require('es6-weak-map')
const shimmer = require('ximmer')
const ao = require('..')
const log = ao.loggers
const conf = ao.probes.oracledb
const {Sanitizer} = ao.addon

module.exports = function (oracledb) {
  const proto = oracledb.constructor.prototype
  if (proto) patchProto(proto, oracledb)

  // TODO BAM here to create proxies. Might require multiple levels.
  return oracledb
}

function patchProto (proto, oracledb) {
  patchGetConnection(proto, oracledb)
  patchCreatePool(proto, oracledb)
  // it seems like oracledb has already created the functions
  // from the prototypes, so try to patch it too. but can't because
  // it's been created with Object.defineProperty without configurable
  // set to true. it is not finding the function in the prototype.
  // the following just confirm that.
  if (oracledb.hasOwnProperty('getConnection')) console.log('hop - getConnection')
  if (oracledb.hasOwnProperty('createPool')) console.log('hop - createPool')
}

const patchedPools = new WeakMap()
function patchCreatePool (proto, oracledb) {
  if (typeof proto.createPool !== 'function') {
    log.debug('ERROR createPool is not a function')
    return
  }
  if (patchedPools.get(proto)) {
    log.debug('ERROR createPool seems to be patched already')
    return
  }
  patchedPools.set(proto, true)
  shimmer.wrap(proto, 'createPool', fn => function (...args) {
    // Retain continuation, if we are in one
    const cb = ao.bind(args.pop())

    console.log('ORACLEDB wrapping createPool')

    // Wrap callback so we can patch the connection
    args.push((err, pool) => {
      if (err) return cb(err)
      const proto = pool && pool.constructor.prototype
      if (proto) patchGetConnection(proto, oracledb, args[0])
      return cb(null, pool)
    })

    return fn.apply(this, args)
  })
}

const patchedConnections = new WeakMap()
function patchGetConnection (proto, oracledb, options) {
  if (typeof proto.getConnection !== 'function') {
    return
  }
  if (patchedConnections.get(proto)) return
  patchedConnections.set(proto, true)

  shimmer.wrap(proto, 'getConnection', fn => function (...args) {
    log.debug('ORACLEDB wrapping getConnection')
    console.log('ORACLEDB wrapping getConnection2')
    // Retain continuation, if we are in one
    const cb = ao.bind(args.pop())

    // Wrap callback so we can patch the connection
    args.push(function (err, conn) {
      if (err) return cb(err)
      const proto = conn && conn.constructor.prototype
      if (proto) patchConnection(proto, oracledb, options || args[0])
      return cb(null, conn)
    })

    return fn.apply(this, args)
  })
}

function patchConnection (conn, oracledb, options) {
  const methods = [
    'execute',
    'commit',
    'rollback',
    'break'
  ]

  methods.forEach(method => patchMethod(conn, method, oracledb, options))
  patchRelease(conn)
}

const patchedMethods = {}
function patchMethod (conn, method, oracledb, options) {
  if (typeof conn[method] !== 'function') return

  // Track if this method of this connection has been patched already
  if (!patchedMethods[method]) {
    patchedMethods[method] = new WeakMap()
  }
  if (patchedMethods[method].get(conn)) return
  patchedMethods[method].set(conn, true)

  shimmer.wrap(conn, method, fn => function (...args) {
    const [query, qArgs] = args
    const cb = args.pop()

    return ao.instrument(
      last => {
        // Parse host and database from connectString
        const parts = options.connectString.split('/')
        const Database = parts.pop()
        const RemoteHost = parts.pop()

        // Build k/v pair object
        const data = {
          Spec: 'query',
          Flavor: 'oracle',
          RemoteHost,
          Database,

          // Report auto-commit status of each query
          isAutoCommit: isAutoCommit(oracledb, args),
          Query: maybeSanitize(maybeQuery(method, query))
        }

        // Only include QueryArgs when not sanitizing
        if (typeof query === 'string' && !conf.sanitizeSql && isArgs(qArgs)) {
          data.QueryArgs = JSON.stringify(qArgs)
        }

        // Trim long queries
        maybeTrimQuery(data)

        return last.descend('oracle', data)
      },
      done => fn.apply(this, args.concat(done)),
      conf,
      cb
    )
  })
}

const patchedReleases = new WeakMap()
function patchRelease (conn) {
  if (typeof conn.release !== 'function') return
  if (patchedReleases.get(conn)) return
  patchedReleases.set(conn, true)

  shimmer.wrap(conn, 'release', fn => function (cb) {
    return fn.call(this, ao.bind(cb))
  })
}

// Trim a value, if it exceeds the specified length,
// and ensure buffers are converted to strings.
function trim (n) {
  return v => v && (v.length > n ? v.slice(0, n) : v).toString()
}

function sanitize (query) {
  return Sanitizer.sanitize(query, Sanitizer.OBOE_SQLSANITIZE_KEEPDOUBLE)
}

function isArgs (v) {
  return Array.isArray(v) || typeof v == 'object'
}

function isAutoCommit (oracledb, args) {
  return (args.length > 2  && typeof args[2].isAutoCommit !== 'undefined')
    ? args[2].isAutoCommit
    : oracledb.isAutoCommit
}

// Some commands, like COMMIT and ROLLBACK are represented as methods,
// so we should use those as the query value when no query is present
function maybeQuery (method, query) {
  return typeof query !== 'string' ? method.toUpperCase() : query
}

function maybeSanitize (query) {
  return conf.sanitizeSql ? sanitize(query) : query
}

function maybeTrimQuery (data) {
  if (data.Query.length > 1024) {
    data.QueryTruncated = true
    data.Query = trim(1024)(data.Query)
  }
}
