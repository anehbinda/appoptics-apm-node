'use strict'

const shimmer = require('ximmer');

let ao;
let aob;
let cls;
let log;
let Event;
let Span;

let dbBind;
let dbInfo;

const udp = process.env.APPOPTICS_REPORTER === 'udp';

module.exports = function (appoptics) {
  ao = appoptics;
  aob = ao.addon;
  cls = ao.cls;
  log = ao.loggers;

  // define the properties (some of which are part of the API)
  definePropertiesOn(ao);

  // create the debounced loggers
  dbBind = new log.Debounce('bind');
  dbInfo = new log.Debounce('info');

  // keep weakmap references in a central place.
  ao.maps.responseIsPatched = responseIsPatched;
  ao.maps.responseFinalizers = responseFinalizers;

  // make these globally available
  Event = require('./event');
  Span = require('./span');

  // return the API
  return {
    // core classes
    Event,
    Span,

    // basic functions
    readyToSample,
    getTraceSettings,
    sampling,
    stringToMetadata,

    // emitter (http) instrumentation
    patchResponse,
    addResponseFinalizer,
    instrumentHttp,

    // non-emitter instrumentation
    instrument,
    pInstrument,
    startOrContinueTrace,
    pStartOrContinueTrace,

    // miscellaneous
    reportError,
    reportInfo,
    sendMetric,
    getFormattedTraceId,
    insertLogObject,
  }
}


//
// Abstract settings with setters and getters
//
let traceMode;
let sampleRate;

function definePropertiesOn (ao) {
  /**
   * Get and set the trace mode
   *
   * @name ao.traceMode
   * @property {string} - the sample mode
   */
  Object.defineProperty(ao, 'traceMode', {
    get () {return ao.modeToStringMap[traceMode]},
    set (value) {
      if (!(value in ao.modeMap)) {
        log.error('invalid traceMode', value)
        return
      }
      log.info('setting traceMode to ' + value)
      value = ao.modeMap[value]
      aob.Context.setTracingMode(value)
      traceMode = value
    }
  })

  /**
   * @ignore
   * Get and set the sample rate. The number is parts of 1,000,000
   * so 100,000 represents a 10% sample rate.
   *
   * @name ao.sampleRate
   * @property {number} - this value divided by 1000000 is the sample rate.
   */
  Object.defineProperty(ao, 'sampleRate', {
    get () {return sampleRate},
    set (value) {
      log.info('set sample rate to ' + value)
      const rateUsed = aob.Context.setDefaultSampleRate(value)
      if (rateUsed !== value && value !== -1) {
        if (rateUsed === -1) {
          // value was not a valid number, don't use it
          log.warn('Invalid sample rate: %s, not changed', value)
          return;
        }
        //
        log.warn('Sample rate (%s) out of range, using %s', value, rateUsed)
      }
      sampleRate = rateUsed
    }
  })

  /**
   * Return whether or not the current code path is being traced.
   *
   * @name ao.tracing
   * @property {boolean}
   * @readOnly
   */
  Object.defineProperty(ao, 'tracing', {
    get () {return !!Event.last}
  });

  /**
   * Get X-Trace ID of the last event
   *
   * @name ao.traceId
   * @property {string} - the trace ID as a string or undefined if not tracing.
   * @readOnly
   */
  Object.defineProperty(ao, 'traceId', {
    get () {
      const last = Event && Event.last;
      if (last) return last.toString();
    }
  });

  Object.defineProperty(ao, 'lastEvent', {
    get () {return Event && Event.last}
  });

  Object.defineProperty(ao, 'lastSpan', {
    get () {return Span && Span.last}
  });

  const maps = {};
  Object.defineProperty(ao, 'maps', {
    get () {return maps}
  });

  //
  // Use continuation-local-storage to maintain context through asynchronous
  // callback chains.
  //
  const storeName = 'ao-cls-context';

  Object.defineProperty(ao, 'requestStore', {
    get () {return cls.getNamespace(storeName) || cls.createNamespace(storeName)}
  });

  ao.resetRequestStore = function resetRequestStore () {
    cls.destroyNamespace(storeName);
  }

  ao.clsCheck = function clsCheck (msg) {
    const c = ao.requestStore;
    const ok = c && c.active;
    if (msg) {
      log.debug('CLS%s %s', ok ? '' : ' NOT ACTIVE', msg)
    }
    return ok
  }

  //
  // ao.stack - generate a stack trace with the call to this function removed
  //
  // text - used as Error(text)
  // n - the depth of the stack trace to generate.
  //
  ao.stack = function stack (text, n) {
    const original = Error.stackTraceLimit
    // increase the stackTraceLimit by one so this function call
    // can be removed.
    if (!n) {
      n = Error.stackTraceLimit
    }
    Error.stackTraceLimit = n + 1

    const e = new Error(text)
    const stackLines = e.stack.split('\n')

    Error.stackTraceLimit = original
    // remove the call to this function
    return [stackLines[0]].concat(stackLines.slice(2)).join('\n')
  }

  /**
   * Generate a backtrace string
   *
   * @method ao.backtrace
   * @returns {string} the backtrace
   */
  ao.backtrace = function backtrace () {
    const e = new Error('backtrace')
    return e.stack.replace(/[^\n]*\n\s+/, '').replace(/\n\s*/g, '\n')
  }

  /**
   * Bind a function to the CLS context if tracing.
   *
   * @method ao.bind
   * @param {function} fn - The function to bind to the context
   * @return {function} The bound function or the unmodified argument if it can't
   *   be bound.
   */
  ao.bind = function bind (fn) {
    try {
      if (ao.tracing && typeof fn === 'function') {
        return ao.requestStore.bind(fn)
      }

      const name = fn ? fn.name : 'anonymous'
      // it's not quite right so issure diagnostic message
      if (!ao.clsCheck()) {
        const e = new Error('CLS NOT ACTIVE')
        log.bind('ao.bind(%s) - no context', name, e.stack)
      } else if (!exports.tracing) {
        log.bind('ao.bind(%s) - not tracing', name)
      } else if (fn !== undefined) {
        const e = new Error('Not a function')
        log.bind('ao.bind(%s) - not a function', fn, e.stack)
      }
    } catch (e) {
      log.error('failed to bind callback', e.stack)
    }

    // return the caller's argument no matter what.
    return fn
  }

  /**
   * Bind an emitter if tracing
   *
   * @method ao.bindEmitter
   * @param {EventEmitter} em The emitter to bind to the trace context
   * @return {EventEmitter} The bound emitter or the original emitter if an error.
   */
  ao.bindEmitter = function bindEmitter (em) {
    let emitter = false
    try {
      if (em && typeof em.on === 'function') {
        emitter = true
        // allow binding if tracing or an http emitter (duck-typing check). no
        // last event has been setup when the http instrumentation binds the
        // events but there must be CLS context.
        if (ao.tracing || (ao.clsCheck() && (em.headers && em.socket))) {
          ao.requestStore.bindEmitter(em)
          return em
        }
      }

      const e = new Error('CLS NOT ACTIVE')
      if (!ao.clsCheck()) {
        dbBind.log('ao.bindEmitter - no context', e.stack)
      } else if (!ao.tracing) {
        dbInfo.log('ao.bindEmitter - not tracing')
      } else if (!emitter) {
        dbBind.log('ao.bindEmitter - non-emitter', e.stack)
      } else {
        dbBind.log('ao.bindEmitter - couldn\'t bind emitter')
      }
    } catch (e) {
      log.error('failed to bind emitter', e.stack)
    }

    // return the original if it couldn't be bound for any reason.
    return em
  }

  /**
   * Set a custom transaction name function for a specific probe. This is
   * most commonly used when setting custom names for all or most routes.
   *
   * @method ao.setCustomTxNameFunction
   * @param {string} probe - The probe to set the function for
   * @param {function} fn - A function that returns a string custom name or a
   *                        falsey value indicating the default should be used.
   *                        Pass a falsey value for the function to clear.
   * @returns {boolean} true if successfully set else false
   *
   * @example
   * // custom transaction function signatures for supported probes:
   * express: customFunction (req, res)
   * hapi: customFunction (request)
   */
  ao.setCustomTxNameFunction = function setCustomTxNameFunction (probe, fn) {
    // if the probe exists set the function and return success
    if (probe in ao.probes && typeof fn === 'function') {
      ao.probes[probe].customNameFunc = fn
      return true
    }
    // return failure
    return false
  }

}


//====================================================================================
// none of the following can be invoked before the initialization function is called
// and sets ao.
//====================================================================================


/**
 * Check whether the appoptics agent is ready to sample. It will wait up to
 * the specified number of milliseconds before returning.
 * @method ao.readyToSample
 * @param {Number} ms - milliseconds to wait; default 0 means don't wait (poll).
 * @param {Object} [obj] - if present obj.status will receive low level status
 * @returns {boolean} - true if ready to sample; false if not
 */
/**
 * @ignore
 * UNKNOWN 0
 * OK 1
 * TRY_LATER 2
 * LIMIT_EXCEEDED 3
 * INVALID_API_KEY 4
 * CONNECT_ERROR 5
 */
function readyToSample (ms, obj) {
  const status = ao.reporter.isReadyToSample(ms)
  // if the caller wants the actual status provide it
  if (obj && typeof obj === 'object') {
    obj.status = status
  }

  return status === 1
}

/**
 * @typedef {object} TraceSettings
 * @property {boolean} doSample - the sample decision
 * @property {boolean} doMetrics - the metrics decision
 * @property {Metadata} metadata - the metadata to use
 * @property {boolean} edge - whether to edge back to metadata
 * @property {number} source - the sample decision source
 * @property {number} rate - the sample rate used
 */

/**
 * make an alias for what will become the new oboe sample call.
 *
 * @ignore
 * @method ao.getTraceSettings
 * @param {string} xtrace
 * @param {number} [localMode=undefined]
 * @returns {TraceSettings} settings
 */
function getTraceSettings (xtrace, localMode) {
  const settings = {xtrace: xtrace || ''}

  if (localMode !== undefined) {
    settings.mode = localMode
  }
  const osettings = aob.Context.getTraceSettings(settings)

  // handle this for testing as oboe doesn't set doMetrics under the UDP
  // protocol.
  if (udp) {
    osettings.doMetrics = osettings.doSample
  }

  ao.lastSettings = osettings

  if (osettings.error) {
    ao.loggers.warn(`getTraceSettings() - ${osettings.message}(${osettings.error})`)
    return {
      doSample: false,
      doMetrics: false,
      source: 5,
      rate: 0,
      edge: false,
      metadata: aob.Metadata.makeRandom(0)
    }
  }

  return osettings
}

/**
 * Determine if the sample flag is set for the various forms of
 * metadata.
 *
 * @method ao.sampling
 * @param {string|Event|Metadata} item - the item to get the sampling flag of
 * @returns {boolean} - true if the sample flag is set else false.
 */

function sampling (item) {
  if (typeof item === 'string') {
    return item.length === 60 && item[59] === '1'
  }

  if (item instanceof Event) {
    return item.event.getSampleFlag()
  }

  if (item instanceof aob.Metadata) {
    return item.getSampleFlag()
  }

  throw new Error('Sampling called with ' + item)
}

/**
 * Convert an xtrace ID to a metadata object.
 *
 * @method ao.stringToMetadata
 * @param {string} xtrace - X-Trace ID, string version of Metadata.
 * @return {bindings.Metadata|undefined} - bindings.Metadata object if
 *                                         successful.
 */
function stringToMetadata (xtrace) {
  // if the conversion fails undefined is returned
  let md

  // the oboe conversion function doesn't check for an all-zero op ID.
  if (xtrace.indexOf('0000000000000000', 42) !== 42) {
    md = aob.Metadata.fromString(xtrace)
  }
  return md
}

/**
 * Patch an HTTP response object to trigger ao-response-end events
 *
 * @ignore
 * @method ao.patchResponse
 * @param {HTTPResponse} res HTTP Response object
 */
const responseIsPatched = new WeakMap()

function patchResponse (res) {
  if (!responseIsPatched.get(res)) {
    responseIsPatched.set(res, true)
    shimmer.wrap(res, 'end', fn => function () {
      // Find and run finalizers
      const finalizers = responseFinalizers.get(res) || []
      finalizers.reverse().forEach(finalizer => finalizer())

      // Cleanup after ourselves
      responseFinalizers.delete(res)
      responseIsPatched.delete(res)

      // Run the real end function
      return fn.apply(this, arguments)
    })
  }
}

/**
 * Add a finalizer to trigger when the response ends
 *
 * @ignore
 * @method ao.addResponseFinalizer
 * @param {HTTPResponse} res - HTTP Response to attach a finalizer to
 * @param {function} finalizer - Finalization function
 */
const responseFinalizers = new WeakMap()

function addResponseFinalizer (res, finalizer) {
  const finalizers = responseFinalizers.get(res)
  finalizers
    ? finalizers.push(finalizer)
    : responseFinalizers.set(res, [finalizer])
}

/**
 * @typedef {object} spanInfo
 * @property {string} name - the name for the span
 * @property {object} [kvpairs] - kvpairs to add to the span
 * @property {function} [finalize] - callback receiving created span
 */

/**
 * @typedef {function} spanInfoFunction
 * @returns {spanInfo}
 */

/**
 * Instrument HTTP request/response
 *
 * @method ao.instrumentHttp
 * @param {string|spanInfoFunction} span - name or function returning spanInfo
 * @param {function} run - code to instrument and run
 * @param {object} [options] - options
 * @param {object} [options.enabled] - enable tracing, on by default
 * @param {object} [options.collectBacktraces] - collect backtraces
 * @param {HTTPResponse} res - HTTP response to patch
 * @returns the value returned by the run function or undefined if it can't be run.
 */
function instrumentHttp (build, run, options, res) {
  // If not tracing, skip
  const last = Span.last
  if (!last) {
    ao.loggers.warn('instrumentHttp: no last span')
    return run()
  }
  if ('enabled' in options && !options.enabled) {
    ao.loggers.info('instrumentHttp: disabled by option')
    return run()
  }

  patchResponse(res)

  let span
  try {
    let name = build
    let kvpairs = {}
    let finalize
    // Build span
    if (typeof build === 'function') {
      const spanInfo = build()
      name = spanInfo.name
      kvpairs = spanInfo.kvpairs || {}
      finalize = spanInfo.finalize
    }

    // attach backtrace if this trace is sampled and configured.
    if (options.collectBacktraces && last.doSample) {
      kvpairs.Backtrace = ao.backtrace(4)
    }
    span = last.descend(name, kvpairs)

    if (finalize) {
      finalize(span, last)
    }

  } catch (e) {
    ao.loggers.error('instrumentHttp failed to build span %s', e.stack)
  }

  let ctx
  try {
    if (span && !span.descended) {
      ctx = ao.requestStore.createContext()
      ao.requestStore.enter(ctx)
    }
  } catch (e) {
    ao.loggers.error('instrumentHttp failed to enter span %l', span)
  }

  if (span) {
    span.enter()
    ao.addResponseFinalizer(res, () => {
      span.exit()
      try {
        if (ctx) {
          ao.requestStore.exit(ctx)
        } else if (!span.descended) {
          ao.loggers.error('no context for undescended span')
        }
      } catch (e) {
        ao.loggers.error('instrumentHttp failed to exit span %l', span)
      }
    })
  }

  try {
    return run.call(span)
  } catch (err) {
    if (span) span.setExitError(err)
    throw err
  }
}

/**
 * Apply custom instrumentation to a synchronous or async-callback function.
 *
 * @method ao.instrument
 * @param {string|spanInfoFunction} span - span name or span-info function
 *     If `span` is a string then a span is created with that name. If it
 *     is a function it will be run only if tracing; it must return a
 *     spanInfo-compatible object - see instrumenting-a-module.md in guides/.
 * @param {function} run - the function to instrument<br/><br/>
 *     Synchronous `run` function:<br/>
 *     the signature has no callback, e.g., `function run () {...}`. If a
 *     synchronous `run` function throws an error appoptics will report that
 *     error for the span and re-throw the error.<br/>
 *     <br/>
 *     Asynchronous `run` function:<br/>
 *     the signature must include a done callback that is used to let
 *     AppOptics know when your instrumented async code is done running,
 *     e.g., `function run (done) {...}`. In order to report an error for
 *     an async span the done function must be called with an Error object
 *     as the argument.
 * @param {object} [options] - options
 * @param {boolean} [options.enabled=true] - enable tracing
 * @param {boolean} [options.collectBacktraces=false] - collect stack traces.
 * @param {function} [callback] - optional callback, if async
 * @returns {value} the value returned by the run function or undefined if it can't be run
 *
 * @example
 * //
 * // A synchronous `run` function.
 * //
 * //   If the run function is synchronous the signature does not include
 * //   a callback, e.g., `function run () {...}`.
 * //
 *
 * function spanInfo () {
 *   return {name: 'custom', kvpairs: {Foo: 'bar'}}
 * }
 *
 * function run () {
 *   const contents = fs.readFileSync('some-file', 'utf8')
 *   // do things with contents
 * }
 *
 * ao.instrument(spanInfo, run)
 *
 * @example
 * //
 * // An asynchronous `run` function.
 * //
 * // Rather than callback directly, you give the done argument.
 * // This tells AppOptics when your instrumented code is done running.
 * //
 * // The `callback` function is the callback you normally would have given
 * // directly to the code you want to instrument. It receives the same
 * // arguments as were received by the `done` callback for the `run` function
 * // and the same `this` context is also applied to it.
 *
 * function spanInfo () {
 *   return {name: 'custom', {Foo: 'bar'}}
 * }
 *
 * function run (done) {
 *   fs.readFile('some-file', done)
 * }
 *
 * function callback (err, data) {
 *   console.log('file contents are: ' + data)
 * }
 *
 * ao.instrument(spanInfo, run, callback)
 */
function instrument (span, run, options, callback) {
  // Verify that a run function is given
  if (typeof run !== 'function') {
    ao.loggers.error(`ao.instrument() run function is ${typeof run}`)
    return
  }

  // Normalize dynamic arguments
  try {
    if (typeof options === 'function') {
      callback = options
      options = {enabled: true}
    } else {
      if (typeof options !== 'object') {
        if (options !== undefined) {
          ao.loggers.warn(`ao.instrument() options is ${typeof options}`)
        }
        options = {}
      }
      // default enabled to true if not explicitly false
      options = Object.assign({enabled: true}, options)
    }

    if (!callback && run.length) {
      callback = function () {};
    }
  } catch (e) {
    ao.loggers.error('ao.instrument failed to normalize arguments', e.stack)
  }

  // If not tracing, there is some error, skip.
  const last = Span.last
  if (!last) {
    if (!ao.startup) {
      ao.loggers.info('ao.instrument found no lastSpan')
    }
    return run(callback)
  }

  // If not enabled, skip but maintain context
  if (!options.enabled) {
    ao.loggers.info('ao.instrument disabled by option')
    return run(ao.bind(callback))
  }

  return runInstrument(last, span, run, options, callback)
}

/**
 * Apply custom instrumentation to a promise-returning asynchronous function.
 *
 * @method ao.pInstrument
 * @param {string|spanInfoFunction} span - span name or span-info function
 *     If `span` is a string then a span is created with that name. If it
 *     is a function it will be run only if tracing; it must return a
 *     spanInfo-compatible object - see instrumenting-a-module.md in guides/.
 * @param {function} run - the function to instrument<br/><br/>
 *     This function must return a promise.
 * @param {object} [options] - options
 * @param {boolean} [options.enabled=true] - enable tracing
 * @param {boolean} [options.collectBacktraces=false] - collect stack traces.
 * @returns {Promise} the value returned by the run function or undefined if it can't be run
 *
 * @example
 * //
 * // A synchronous `run` function.
 * //
 * //   If the run function is synchronous the signature does not include
 * //   a callback, e.g., `function run () {...}`.
 * //
 *
 * function spanInfo () {
 *   return {name: 'custom', kvpairs: {Foo: 'bar'}}
 * }
 *
 * function run () {
 *   return axios.get('https://google.com').then(r => {
 *     ...
 *     return r;
 *   })
 * }
 *
 * ao.pInstrument(spanInfo, run).then(...)
 */
function pInstrument (name, task, options = {}) {
  if (typeof task !== 'function') {
    return instrument(...arguments)
  }

  const wrapped = cb => {
    const p = task();
    if (!p || !p.then) {
      cb();
      return p
    }
    return p.then(r => {
      cb();
      return r;
    }).catch(e => {
      cb(e);
      throw e;
    })
  }

  // this needs to appear async to ao.instrument, so wrapped supplies a callback. but
  // this code doesn't have a callback because the resolution of the promise is what
  // signals the task function's completion, so no 4th argument is supplied.
  //
  // ao.instrument returns wrapped()'s value which is the original promise
  // that task() returns. the resolution of the promise is the value that
  // task() resolved the promise with or a thrown error. the point of
  // wrapped() is to make the callback that results in exiting the the span before
  // resolving the promise.
  return instrument(name, wrapped, options)
}

//
// This builds a span descending from the supplied span using the ao.instrument's arguments
//
function runInstrument (last, make, run, options, callback) {
  // Verify that a name or span-info function is given
  if (!~['function', 'string'].indexOf(typeof make)) {
    ao.loggers.error('ao.runInstrument found no span name or span-info function')
    return run(callback)
  }

  // Build span. Because last must exist this function cannot be used
  // for a root span.
  let span
  try {
    let name = make
    let kvpairs = {}
    let finalize
    if (typeof make === 'function') {
      const spanInfo = make(last)
      name = spanInfo.name
      kvpairs = spanInfo.kvpairs
      finalize = spanInfo.finalize
    }
    if (name) {
      span = last.descend(name, kvpairs)
    }

    if (finalize) {
      finalize(span, last)
    }
  } catch (e) {
    ao.loggers.error('ao.runInstrument failed to build span', e.stack)
  }

  // run span
  return runSpan(span, run, options, callback)
}

//
// Set backtrace, if configured to do so, and run already constructed span
//
function runSpan (span, run, options, callback) {
  if (!span) {
    return run(callback)
  }

  // Attach backtrace if sampling and enabled.
  if (span.doSample && options.collectBacktraces) {
    span.events.entry.set({Backtrace: ao.backtrace()})
  }

  // save the transaction name properties if doing metrics.
  if (span.topSpan && span.doMetrics) {
    span.defaultTxName = options.defaultTxName
    span.customTxName = options.customTxName
  }

  // Detect if sync or async, and run span appropriately
  return callback
    ? span.runAsync(makeWrappedRunner(run, callback))
    : span.runSync(run)
}

// This makes a callback-wrapping span runner
function makeWrappedRunner (run, callback) {
  return wrap => run(wrap(callback))
}

/**
 * Start or continue a trace. Continue is in the sense of continuing a
 * trace based on an X-Trace ID received from an external source, e.g.,
 * HTTP headers or message queue headers.
 *
 * @method ao.startOrContinueTrace
 * @param {string} xtrace - X-Trace ID to continue from or null
 * @param {string|spanInfoFunction} span - name or function returning spanInfo
 * @param {function} run - run this function. sync if no arguments, async if one.
 * @param {object}  [opts] - options
 * @param {boolean} [opts.enabled=true] - enable tracing
 * @param {boolean} [opts.collectBacktraces=false] - collect backtraces
 * @param {string|function} [opts.customTxName] - name or function
 * @returns {value} the value returned by the run function or undefined if it can't be run
 *
 * @example
 * ao.startOrContinueTrace(
 *   null,
 *   'sync-span-name',
 *   functionToRun,           // synchronous so function takes no arguments
 *   {customTxName: 'special-span-name'}
 * )
 * @example
 * ao.startOrContinueTrace(
 *   null,
 *   'sync-span-name',
 *   functionToRun,
 *   // note - no context is provided for the customTxName function. If
 *   // context is required the caller should wrap the function in a closure.
 *   {customTxName: customNameFunction}
 * )
 * @example
 * // this is the function that should be instrumented
 * request('https://www.google.com', function realCallback (err, res, body) {...})
 * // because asyncFunctionToRun only accepts one parameter it must be
 * // wrapped, so the function to run becomes
 * function asyncFunctionToRun (cb) {
 *   request('https://www.google.com', cb)
 * }
 * // and realCallback is supplied as the optional callback parameter
 *
 * ao.startOrContinueTrace(
 *   null,
 *   'async-span-name',
 *   asyncFunctionToRun,     // async, so function takes one argument
 *   // no options this time
 *   realCallback            // receives request's callback arguments.
 * )
 */
function startOrContinueTrace (xtrace, build, run, opts, cb) {
  // Verify that a run function is given
  if (typeof run !== 'function') return

  try {
    if (typeof opts !== 'object') {
      cb = opts
      opts = {enabled: true}
    } else {
      // default enabled to true if not explicitly false
      opts = Object.assign({enabled: true}, opts)
    }

    if (!cb && run.length) {
      cb = function () {};
    }
  } catch (e) {
    ao.loggers.error('ao.startOrContinueTrace can\'t normalize arguments', e.stack)
  }

  // verify that a span name or span-info function is provided. it is called
  // build for historical reasons.
  if (!~['function', 'string'].indexOf(typeof build)) {
    return run(cb)
  }

  // If not enabled, skip
  if (!opts.enabled) {
    return run(ao.bind(cb))
  }

  // If already tracing, continue the existing trace ignoring
  // any xtrace passed as the first argument.
  const last = Span.last
  if (last) {
    return runInstrument(last, build, run, opts, cb)
  }

  // Should this be sampled?
  let settings
  try {
    settings = getTraceSettings(xtrace)
  } catch (e) {
    ao.loggers.error('ao.startOrContinueTrace can\'t get a sample decision', e.stack)
    settings = {doSample: false, doMetrics: false, source: 5, rate: 0}
  }

  let span
  try {
    // try to create the span
    let name = build
    let kvpairs = {}
    let finalize
    if (typeof build === 'function') {
      const spanInfo = build()
      name = spanInfo.name
      kvpairs = spanInfo.kvpairs
      finalize = spanInfo.finalize
    }
    span = Span.makeEntrySpan(name, settings, kvpairs)

    if (finalize) {
      // no last or runInstrument() would already have been called.
      finalize(span)
    }
  } catch (e) {
    ao.loggers.error('ao.startOrContinueTrace failed to build span %s', build)
  }

  // if no span can't do sampling or inbound metrics - need a context.
  if (!span) {
    return run(cb)
  }

  // Add sampling data to entry if there was not already an xtrace ID
  if (settings.doSample && !xtrace) {
    span.events.entry.set({
      SampleSource: settings.source,
      SampleRate: settings.rate
    })
  }

  // supply a default in case the user didn't provide a txname or a
  // function to return a txname. if the span is unnamed then let oboe
  // provide "unknown"
  opts.defaultTxName = span.name ? 'custom-' + span.name : ''

  return runSpan(span, run, opts, cb)
}

/**
 * Start or continue a trace running a function that returns a promise. Continue is in
 * the sense of continuing a trace based on an X-Trace ID received from an external
 * source, e.g., HTTP headers or message queue headers.
 *
 * @method ao.pStartOrContinueTrace
 * @param {string} xtrace - X-Trace ID to continue from or null
 * @param {string|spanInfoFunction} span - name or function returning spanInfo
 * @param {function} run - the promise-returning function to instrument
 * @param {object}  [opts] - options
 * @param {boolean} [opts.enabled=true] - enable tracing
 * @param {boolean} [opts.collectBacktraces=false] - collect backtraces
 * @param {string|function} [opts.customTxName] - name or function
 * @returns {Promise} the value returned by the run function or undefined if it can't be run
 *
 * @example
 *
 * function spanInfo () {
 *   return {name: 'custom', kvpairs: {Foo: 'bar'}}
 * }
 *
 * // axios returns a promise
 * function functionToRun () {
 *   return axios.get('https://google.com').then(r => {
 *     ...
 *     return r;
 *   })
 * }
 *
 * ao.pStartOrContinueTrace(
 *   null,
 *   spanInfo,
 *   functionToRun,
 * ).then(...)
 */
function pStartOrContinueTrace (xtrace, name, task, options = {}) {
  if (typeof task !== 'function') {
    return startOrContinueTrace(...arguments);
  }

  const wrapped = cb => {
    const p = task();
    if (!p || !p.then) {
      cb();
      return p
    }
    return p.then(r => {
      cb();
      return r;
    }).catch(e => {
      cb(e);
      throw e;
    })
  }

  return startOrContinueTrace(xtrace, name, wrapped, options);
}

/**
 * Report an error event in the current trace.
 *
 * @method ao.reportError
 * @param {Error} error - The error instance to report
 */
function reportError (error) {
  const last = Span.last
  if (last) last.error(error)
}

/**
 * Report an info event in the current trace.
 *
 * @method ao.reportInfo
 * @param {object} data - Data to report in the info event
 */
function reportInfo (data) {
  const last = Span.last
  if (last) last.info(data)
}


//
// sendMetric(name, object)
//
// only the first argument is required for an increment call.
//
// name - the name of the metric
// object - an object containing optional parameters
// object.count - the number of observations being reported (default: 1)
// object.addHostTag - boolean - add {host: hostname} to tags.
// object.tags - an object containing {tag: value} pairs.
// object.value - if present this call is a valued-based call and this contains
//                the value, or sum of values if count is greater than 1, being
//                reported.
//
// there are two types of metrics:
//   1) count-based - the number of times something has occurred (no value associated with this metric)
//   2) value-based - a specific value is being reported (or a sum of values)
//
//

//
// returns -1 for success else error code. the only error now is 0.
//
/**
 * Send a custom metric. There are two types of metrics:
 * 1) count-based - the number of times something has occurred (no value is associated with this type)
 * 2) value-based - a specific value (or sum of values).
 * If options.value is present the metric being reported is value-based.
 *
 * @method ao.sendMetric
 * @param {string} name - the name of the metric
 * @param {object} [options]
 * @param {number} [options.count=1] - the number of observations being reported
 * @param {number} [options.value] - if present the metric is value based and this
 *                                   is the value, or sum of the values if count is
 *                                   greater than 1
 * @param {boolean} [options.addHostTag] - add {host: hostname} to tags
 * @param {object} [options.tags] - an object containing {tag: value} pairs
 *
 * @throws {TypeError} - if an invalid argument is supplied
 * @returns {number} - -1 for success else an error code.
 *
 * @example
 *
 * // simplest forms
 * ao.sendMetric('my.little.count')
 * ao.sendMetric('my.little.value', {value: 234.7})
 *
 * // report two observations
 * ao.sendMetric('my.little.count', {count: 2})
 * ao.sendMetric('my.little.value', {count: 2, value: 469.4})
 *
 * // to supply tags that can be used for filtering
 * ao.sendMetric('my.little.count', {tags: {status: error}})
 *
 * // to have a host name tag added automatically
 * ao.sendMetric('my.little.count', {addHostTag: true, tags: {status: error}})
 *
 */
function sendMetric (name, options) {
  return aob.Reporter.sendMetric(name, options);
}

//
// format control bits
// header = 1;
// task = 2;
// op = 4;
// flags = 8;          // include all flags (2 hex chars)
// sample = 16;        // sample bit only (0 or 1)
// separators = 32;    // separate fields with '-'
// lowercase = 64;     // lowercase alpha hex chars
//
// Metadata.fmtHuman = header | task | op | flags | separators | lowercase;
// Metadata.fmtLog = task | sample | separators;
//
/**
 * Get the abbreviated trace ID format used for logs.
 *
 * @method ao.getFormattedTraceId
 * @returns {string} - 40 character trace identifier - sample flag
 *
 * @example
 *
 * //
 * // using morgan in express
 * //
 * const ao = require('appoptics');
 * const Express = require('express');
 * const app = new Express();
 * const morgan = require('morgan');
 *
 * // define a format with a new token in it, 'trace-id' or a name of your choosing.
 * const logFormat = ':method :url :status :res[content-length] :trace-id - :response-time ms';
 * // define a token for the name used in the format. return
 * morgan.token('trace-id', function (req, res) {return ao.getFormattedTraceId();});
 * const logger = morgan(logFormat, {...});
 * app.use(logger);
 * // now the 42-character trace-id will be added to log entries.
 */
function getFormattedTraceId (options = {}) {
  const format = options.format || aob.Metadata.fmtLog;
  return Event.last ? Event.last.event.toString(format) : '0000000000000000000000000000000000000000-0';
}

/**
 * Insert the appoptics object containing a trace ID into an object. The primary intended use for this is
 * to auto-insert traceIds into JSON-like logs; it's documented so it can be used for unsupported logging
 * packages or by those wishing a higher level of control.
 *
 * @method ao.insertLogObject
 * @param {object} [object] - inserts an ao log object containing a traceId property when conditions are met.
 * @returns {object} - the object with the an additional property, ao, e.g., object.ao === {traceId: ...}.
 *
 * @example
 *
 * const ao = require('appoptics-apm');
 * const logger = require('pino')();
 *
 * // with no object as an argument ao.insertLogObject returns {ao: {traceId: ...}}
 * logger.info(ao.insertLogObject(), 'not-so-important message');
 *
 * @example
 *
 * const ao = require('appoptics-apm');
 * const winston = require('winston');
 * const logger = winston.createLogger({
 *     level: 'info',
 *     format: winston.format.combine(
 *       winston.format.splat(),
 *       winston.format.json()
 *     ),
 *     defaultMeta: {service: 'ao-log-example'},
 *     transports: [...]
 * })
 *
 * logger.info(ao.insertLogObject({
 *     message: 'this object is being modified by insertLogObject',
 *     more: 'there will be an added ao property'
 * }))
 */
function insertLogObject (o = {}) {
  // if truthy and tracing insert it based on sample setting. otherwise if 'always'
  // then insert a trace ID regardless. No explicit check for 'traced' is required.
  if (ao.cfg.insertTraceIdsIntoLogs && Event.last) {
    if (ao.cfg.insertTraceIdsIntoLogs !== 'sampledOnly' || Event.last.event.getSampleFlag()) {
      o.ao = {traceId: ao.getFormattedTraceId()};
    }
  } else if (ao.cfg.insertTraceIdsIntoLogs === 'always') {
    o.ao = {traceId: ao.getFormattedTraceId()};
  }
  return o;
}

