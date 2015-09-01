exports.data = function (ctx) {
  return {
    url: 'http://localhost:' + ctx.data.port + '/?foo=bar'
  }
}

exports.run = function (ctx, done) {
  var req = ctx.http.get(ctx.data.url)
  req.on('response', function (res) {
    res.resume()
    res.on('end', done.bind(null, null))
  })
  req.on('error', done)
}
