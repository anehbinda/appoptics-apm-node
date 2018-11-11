var helper = require('../helper')
var ao = helper.ao
var Span = ao.Span

var redis = require('redis')
var db_host = process.env.REDIS_PORT_6379_TCP_ADDR || 'redis'
var client = redis.createClient(6379, db_host, {})

tracelyzer.setMaxListeners(Infinity)

suite('probes/redis', function () {
  var context = {}

  before(function () {
    ao.requestStore.enter(context)
    span = new Span('test', null, {})
    span.enter()
  })
  after(function () {
    ao.requestStore.exit(context)
    span.exit()
  })

  bench('set', function (done) {
    var cb = after(3, done)
    multi_on(tracelyzer, 2, 'message', cb)
    client.set('foo', 'bar', cb)
  })

  bench('get', function (done) {
    var cb = after(3, done)
    multi_on(tracelyzer, 2, 'message', cb)
    client.get('foo', cb)
  })

  bench('del', function (done) {
    var cb = after(3, done)
    multi_on(tracelyzer, 2, 'message', cb)
    client.del('foo', cb)
  })

  bench('multi', function (done) {
    var cb = after(3, done)
    multi_on(tracelyzer, 2, 'message', cb)
    client.multi()
      .set('foo', 'bar')
      .get('foo')
      .exec(cb)
  })
})

function after (n, cb) {
  return function () {
    --n || cb()
  }
}

function multi_on (em, n, ev, cb) {
  function step () {
    if (n-- > 0) em.once(ev, function () {
      cb.apply(this, arguments)
      step()
    })
  }
  step()
}
