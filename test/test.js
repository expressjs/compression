var http = require('http');
var request = require('supertest');
var should = require('should');

var compress = require('..');

describe('compress()', function(){
  it('should gzip files', function(done){
    var server = createServer({ threshold: 0 }, function (req, res) {
      res.setHeader('Content-Type', 'text/plain')
      res.end('hello, world')
    })

    request(server)
    .get('/')
    .set('Accept-Encoding', 'gzip')
    .expect('Content-Encoding', 'gzip', done)
  })

  it('should skip HEAD', function(done){
    var server = createServer({ threshold: 0 }, function (req, res) {
      res.setHeader('Content-Type', 'text/plain')
      res.end('hello, world')
    })

    request(server)
    .head('/')
    .set('Accept-Encoding', 'gzip')
    .end(function (err, res) {
      if (err) return done(err)
      res.headers.should.not.have.property('content-encoding')
      done()
    })
  })

  it('should set Vary', function(done){
    var server = createServer({ threshold: 0 }, function (req, res) {
      res.setHeader('Content-Type', 'text/plain')
      res.end('hello, world')
    })

    request(server)
    .get('/')
    .set('Accept-Encoding', 'gzip')
    .expect('Content-Encoding', 'gzip')
    .expect('Vary', 'Accept-Encoding', done)
  })

  it('should append to Vary', function(done){
    var server = createServer({ threshold: 0 }, function (req, res) {
      res.setHeader('Content-Type', 'text/plain')
      res.setHeader('Vary', 'User-Agent')
      res.end('hello, world')
    })

    request(server)
    .get('/')
    .set('Accept-Encoding', 'gzip')
    .expect('Content-Encoding', 'gzip')
    .expect('Vary', 'User-Agent, Accept-Encoding', done)
  })

  it('should not double-append to Vary', function(done){
    var server = createServer({ threshold: 0 }, function (req, res) {
      res.setHeader('Content-Type', 'text/plain')
      res.setHeader('Vary', 'Accept-Encoding, User-Agent')
      res.end('hello, world')
    })

    request(server)
    .get('/')
    .set('Accept-Encoding', 'gzip')
    .expect('Content-Encoding', 'gzip')
    .expect('Vary', 'Accept-Encoding, User-Agent', done)
  })

  it('should set Vary even if Accept-Encoding is not set', function(done){
    var server = createServer({ threshold: 1000 }, function (req, res) {
      res.setHeader('Content-Type', 'text/plain')
      res.end('hello, world')
    })

    request(server)
    .get('/')
    .expect('Vary', 'Accept-Encoding')
    .end(function (err, res) {
      if (err) return done(err)
      res.headers.should.not.have.property('content-encoding')
      done()
    })
  })

  it('should not set Vary if Content-Type does not pass filter', function(done){
    var server = createServer(null, function (req, res) {
      res.setHeader('Content-Type', 'image/jpeg')
      res.end()
    })

    request(server)
    .get('/')
    .end(function (err, res) {
      if (err) return done(err)
      res.headers.should.not.have.property('vary')
      done()
    })
  })

  it('should transfer chunked', function(done){
    var server = createServer({ threshold: 0 }, function (req, res) {
      res.setHeader('Content-Type', 'text/plain')
      res.end('hello, world')
    })

    request(server)
    .get('/')
    .set('Accept-Encoding', 'gzip')
    .expect('Transfer-Encoding', 'chunked', done)
  })

  it('should remove Content-Length for chunked', function(done){
    var server = createServer({ threshold: 0 }, function (req, res) {
      res.setHeader('Content-Type', 'text/plain')
      res.end('hello, world')
    })

    request(server)
    .get('/')
    .expect('Content-Encoding', 'gzip')
    .end(function (err, res) {
      if (err) return done(err)
      res.headers.should.not.have.property('content-length')
      done()
    })
  })

  describe('threshold', function(){
    it('should not compress responses below the threshold size', function(done){
      var server = createServer({ threshold: '1kb' }, function (req, res) {
        res.setHeader('Content-Type', 'text/plain')
        res.setHeader('Content-Length', '12')
        res.end('hello, world')
      })

      request(server)
      .get('/')
      .set('Accept-Encoding', 'gzip')
      .end(function(err, res){
        if (err) return done(err)
        res.headers.should.not.have.property('content-encoding')
        done()
      })
    })

    it('should compress responses above the threshold size', function(done){
      var server = createServer({ threshold: '1kb' }, function (req, res) {
        res.setHeader('Content-Type', 'text/plain')
        res.setHeader('Content-Length', '2048')
        res.end(new Buffer(2048))
      })

      request(server)
      .get('/')
      .set('Accept-Encoding', 'gzip')
      .expect('Content-Encoding', 'gzip', done)
    })

    it('should compress when streaming without a content-length', function(done){
      var server = createServer({ threshold: '1kb' }, function (req, res) {
        res.setHeader('Content-Type', 'text/plain')
        res.write('hello, ')
        setTimeout(function(){
          res.end('world')
        }, 10)
      })

      request(server)
      .get('/')
      .set('Accept-Encoding', 'gzip')
      .expect('Content-Encoding', 'gzip', done)
    })

    it('should not compress when streaming and content-length is lower than threshold', function(done){
      var server = createServer({ threshold: '1kb' }, function (req, res) {
        res.setHeader('Content-Type', 'text/plain')
        res.setHeader('Content-Length', '12')
        res.write('hello, ')
        setTimeout(function(){
          res.end('world')
        }, 10)
      })

      request(server)
      .get('/')
      .set('Accept-Encoding', 'gzip')
      .end(function(err, res){
        if (err) return done(err)
        res.headers.should.not.have.property('content-encoding')
        done()
      })
    })

    it('should compress when streaming and content-length is larger than threshold', function(done){
      var server = createServer({ threshold: '1kb' }, function (req, res) {
        res.setHeader('Content-Type', 'text/plain')
        res.setHeader('Content-Length', '2048')
        res.write(new Buffer(1024))
        setTimeout(function(){
          res.end(new Buffer(1024))
        }, 10)
      })

      request(server)
      .get('/')
      .set('Accept-Encoding', 'gzip')
      .expect('Content-Encoding', 'gzip', done)
    })
  })

  describe('res.flush()', function () {
    it('should always be present', function (done) {
      var server = createServer(null, function (req, res) {
        res.statusCode = typeof res.flush === 'function'
          ? 200
          : 500
        res.end()
      })

      request(server)
      .get('/')
      .expect(200, done)
    })

    // If anyone knows how to test if the flush works...
    // it('should flush the response', function (done) {

    // })
  })
})

function createServer(opts, fn) {
  var _compress = compress(opts)
  return http.createServer(function (req, res) {
    _compress(req, res, function (err) {
      if (err) {
        res.statusCode = err.status || 500
        res.end(err.message)
        return;
      }

      fn(req, res)
    })
  })
}
