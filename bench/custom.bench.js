var helper = require('./helper')
var ao = helper.ao
var Span = ao.Span

suite('custom', function () {
  var context = {}

  before(function () {
    ao.requestStore.enter(context)
  })

  after(function () {
    ao.requestStore.exit(context)
  })

  bench('custom instrumentation with name', function () {
    ao.instrument('test', noop)
  })

  bench('custom instrumentation with builder function', function () {
    ao.instrument(builder, noop)
  })

  bench('custom instrumentation with callback', function (done) {
    ao.instrument('test', callIt, function () {
      setImmediate(done)
    })
  })
})

function builder (span) {
  return span.descend('test')
}

function noop () {}

function callIt (done) {
  done()
}
