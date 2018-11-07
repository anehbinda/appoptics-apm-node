var helper = require('../helper')
var ao = helper.ao
var Span = ao.Span

var amqp = require('amqp')
var db_host = process.env.RABBITMQ_PORT_5672_TCP_ADDR || 'localhost'

tracelyzer.setMaxListeners(Infinity)

suite('probes/amqp', function () {
  var context = {}
  var client
  var span
  var ex

  before(function (done) {
    client = amqp.createConnection({ host: db_host }, { reconnect: false })
    client.on('ready', done)
  })
  after(function (done) {
    // NOTE: 1.x has no disconnect() and socket.end() is not safe.
    if (client.disconnect) {
      client.on('close', function () {
        done()
      })
      client.disconnect()
    } else {
      done()
    }
  })

  before(function () {
    ao.requestStore.enter(context)
    span = new Span('test', null, {})
    span.enter()
  })
  after(function () {
    ao.requestStore.exit(context)
    span.exit()
  })

  bench('confirmed publish', function (done) {
    multi_on(tracelyzer, 2, 'message', after(2, done))
    var ex = client.exchange('test', { confirm: true }, function () {
      ex.publish('test', { foo: 'bar' }, { mandatory: true }, function () {})
    })
  })

  bench('unconfirmed publish', function (done) {
    multi_on(tracelyzer, 2, 'message', after(2, done))
    var ex = client.exchange('test', {}, function () {
      ex.publish('test', { foo: 'bar' })
    })
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
