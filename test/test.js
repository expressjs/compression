var crypto = require('crypto');
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

  it('should skip unknown accept-encoding', function(done){
    var server = createServer({ threshold: 0 }, function (req, res) {
      res.setHeader('Content-Type', 'text/plain')
      res.end('hello, world')
    })

    request(server)
    .get('/')
    .set('Accept-Encoding', 'bogus')
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

  it('should back-pressure when compressed', function(done){
    var buf
    var client
    var drained = false
    var resp
    var server = createServer({ threshold: 0 }, function (req, res) {
      resp = res
      res.on('drain', function(){
        drained = true
      })
      res.setHeader('Content-Type', 'text/plain')
      res.write('start')
      pressure()
    })
    var wait = 2

    crypto.pseudoRandomBytes(1024 * 128, function(err, chunk){
      buf = chunk
      pressure()
    })

    function complete(){
      if (--wait !== 0) return
      drained.should.be.true
      done()
    }

    function pressure(){
      if (!buf || !resp || !client) return

      while (resp.write(buf) !== false) {
        resp.flush()
      }

      resp.on('drain', function(){
        resp.write('end')
        resp.end()
      })
      resp.on('finish', complete)
      client.resume()
    }

    request(server)
    .get('/')
    .request()
    .on('response', function (res) {
      client = res
      res.headers['content-encoding'].should.equal('gzip')
      res.pause()
      res.on('end', complete)
      pressure()
    })
    .end()
  })

  it('should back-pressure when uncompressed', function(done){
    var buf
    var client
    var drained = false
    var resp
    var server = createServer({ filter: function(){ return false } }, function (req, res) {
      resp = res
      res.on('drain', function(){
        drained = true
      })
      res.setHeader('Content-Type', 'text/plain')
      res.write('start')
      pressure()
    })
    var wait = 2

    crypto.pseudoRandomBytes(1024 * 128, function(err, chunk){
      buf = chunk
      pressure()
    })

    function complete(){
      if (--wait !== 0) return
      drained.should.be.true
      done()
    }

    function pressure(){
      if (!buf || !resp || !client) return

      while (resp.write(buf) !== false) {
        resp.flush()
      }

      resp.on('drain', function(){
        resp.write('end')
        resp.end()
      })
      resp.on('finish', complete)
      client.resume()
    }

    request(server)
    .get('/')
    .request()
    .on('response', function (res) {
      client = res
      res.headers.should.not.have.property('content-encoding')
      res.pause()
      res.on('end', complete)
      pressure()
    })
    .end()
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

    // res.end(str, encoding) broken in node.js 0.8
    var run = /^v0\.8\./.test(process.version) ? it.skip : it
    run('should handle writing hex data', function(done){
      var server = createServer({ threshold: 6 }, function (req, res) {
        res.setHeader('Content-Type', 'text/plain')
        res.end('2e2e2e2e', 'hex')
      })

      request(server)
      .get('/')
      .set('Accept-Encoding', 'gzip')
      .expect(200, '....', function (err, res) {
        if (err) return done(err)
        res.headers.should.not.have.property('content-encoding')
        done()
      })
    })
  })

  describe('res.flush()', function () {
    it('should always be present', function (done) {
      var server = createServer(null, function (req, res) {
        res.statusCode = typeof res.flush === 'function'
          ? 200
          : 500
        res.flush()
        res.end()
      })

      request(server)
      .get('/')
      .expect(200, done)
    })

    it('should flush the response', function (done) {
      var chunks = 0
      var resp
      var server = createServer({ threshold: 0 }, function (req, res) {
        resp = res
        res.setHeader('Content-Type', 'text/plain')
        res.setHeader('Content-Length', '2048')
        write()
      })

      function write() {
        chunks++
        if (chunks === 2) return resp.end()
        if (chunks > 2) return chunks--
        resp.write(new Buffer(1024))
        resp.flush()
      }

      request(server)
      .get('/')
      .set('Accept-Encoding', 'gzip')
      .request()
      .on('response', function (res) {
        res.headers['content-encoding'].should.equal('gzip')
        res.on('data', write)
        res.on('end', function(){
          chunks.should.equal(2)
          done()
        })
      })
      .end()
    })

    it('should flush small chunks for gzip', function (done) {
      var chunks = 0
      var resp
      var server = createServer({ threshold: 0 }, function (req, res) {
        resp = res
        res.setHeader('Content-Type', 'text/plain')
        write()
      })

      function write() {
        chunks++
        if (chunks === 20) return resp.end()
        if (chunks > 20) return chunks--
        resp.write('..')
        resp.flush()
      }

      request(server)
      .get('/')
      .set('Accept-Encoding', 'gzip')
      .request()
      .on('response', function (res) {
        res.headers['content-encoding'].should.equal('gzip')
        res.on('data', write)
        res.on('end', function(){
          chunks.should.equal(20)
          done()
        })
      })
      .end()
    })

    it('should flush small chunks for deflate', function (done) {
      var chunks = 0
      var resp
      var server = createServer({ threshold: 0 }, function (req, res) {
        resp = res
        res.setHeader('Content-Type', 'text/plain')
        write()
      })

      function write() {
        chunks++
        if (chunks === 20) return resp.end()
        if (chunks > 20) return chunks--
        resp.write('..')
        resp.flush()
      }

      request(server)
      .get('/')
      .set('Accept-Encoding', 'deflate')
      .request()
      .on('response', function (res) {
        res.headers['content-encoding'].should.equal('deflate')
        res.on('data', write)
        res.on('end', function(){
          chunks.should.equal(20)
          done()
        })
      })
      .end()
    })
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
