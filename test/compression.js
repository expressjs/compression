var assert = require('assert')
var bytes = require('bytes');
var crypto = require('crypto');
var http = require('http');
var request = require('supertest');

var compression = require('..');

describe('compression()', function(){
  it('should skip HEAD', function(done){
    var server = createServer({ threshold: 0 }, function (req, res) {
      res.setHeader('Content-Type', 'text/plain')
      res.end('hello, world')
    })

    request(server)
    .head('/')
    .set('Accept-Encoding', 'gzip')
    .expect(shouldNotHaveHeader('Content-Encoding'))
    .expect(200, done)
  })

  it('should skip unknown accept-encoding', function(done){
    var server = createServer({ threshold: 0 }, function (req, res) {
      res.setHeader('Content-Type', 'text/plain')
      res.end('hello, world')
    })

    request(server)
    .get('/')
    .set('Accept-Encoding', 'bogus')
    .expect(shouldNotHaveHeader('Content-Encoding'))
    .expect(200, done)
  })

  it('should skip if content-encoding already set', function(done){
    var server = createServer({ threshold: 0 }, function (req, res) {
      res.setHeader('Content-Type', 'text/plain')
      res.setHeader('Content-Encoding', 'x-custom')
      res.end('hello, world')
    })

    request(server)
    .get('/')
    .set('Accept-Encoding', 'gzip')
    .expect('Content-Encoding', 'x-custom')
    .expect(200, 'hello, world', done)
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

  it('should set Vary even if Accept-Encoding is not set', function(done){
    var server = createServer({ threshold: 1000 }, function (req, res) {
      res.setHeader('Content-Type', 'text/plain')
      res.end('hello, world')
    })

    request(server)
    .get('/')
    .expect('Vary', 'Accept-Encoding')
    .expect(shouldNotHaveHeader('Content-Encoding'))
    .expect(200, done)
  })

  it('should not set Vary if Content-Type does not pass filter', function(done){
    var server = createServer(null, function (req, res) {
      res.setHeader('Content-Type', 'image/jpeg')
      res.end()
    })

    request(server)
    .get('/')
    .expect(shouldNotHaveHeader('Vary'))
    .expect(200, done)
  })

  it('should set Vary for HEAD request', function(done){
    var server = createServer({ threshold: 0 }, function (req, res) {
      res.setHeader('Content-Type', 'text/plain')
      res.end('hello, world')
    })

    request(server)
    .head('/')
    .set('Accept-Encoding', 'gzip')
    .expect('Vary', 'Accept-Encoding', done)
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
    .expect(shouldNotHaveHeader('Content-Length'))
    .expect(200, done)
  })

  it('should allow writing after close', function(done){
    // UGH
    var server = createServer({ threshold: 0 }, function (req, res) {
      res.setHeader('Content-Type', 'text/plain')
      res.on('close', function () {
        res.write('hello, ')
        res.end('world')
        done()
      })
      res.destroy()
    })

    request(server)
    .get('/')
    .end(function(){})
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
      assert.ok(drained)
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
      assert.equal(res.headers['content-encoding'], 'gzip')
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
      assert.ok(drained)
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
      shouldNotHaveHeader('Content-Encoding')(res)
      res.pause()
      res.on('end', complete)
      pressure()
    })
    .end()
  })

  it('should transfer large bodies', function (done) {
    var len = bytes('1mb')
    var buf = new Buffer(len)
    var server = createServer({ threshold: 0 }, function (req, res) {
      res.setHeader('Content-Type', 'text/plain')
      res.end(buf)
    })

    buf.fill('.')

    request(server)
    .get('/')
    .set('Accept-Encoding', 'gzip')
    .expect('Transfer-Encoding', 'chunked')
    .expect('Content-Encoding', 'gzip')
    .expect(shouldHaveBodyLength(len))
    .expect(200, buf.toString(), done)
  })

  it('should transfer large bodies with multiple writes', function (done) {
    var len = bytes('40kb')
    var buf = new Buffer(len)
    var server = createServer({ threshold: 0 }, function (req, res) {
      res.setHeader('Content-Type', 'text/plain')
      res.write(buf)
      res.write(buf)
      res.write(buf)
      res.end(buf)
    })

    buf.fill('.')

    request(server)
    .get('/')
    .set('Accept-Encoding', 'gzip')
    .expect('Transfer-Encoding', 'chunked')
    .expect('Content-Encoding', 'gzip')
    .expect(shouldHaveBodyLength(len * 4))
    .expect(200, done)
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
      .expect(shouldNotHaveHeader('Content-Encoding'))
      .expect(200, done)
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
      .expect(shouldNotHaveHeader('Content-Encoding'))
      .expect(200, done)
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
      .expect(shouldNotHaveHeader('Content-Encoding'))
      .expect(200, '....', done)
    })
  })

  describe('when "Accept-Encoding: gzip"', function () {
    it('should respond with gzip', function (done) {
      var server = createServer({ threshold: 0 }, function (req, res) {
        res.setHeader('Content-Type', 'text/plain')
        res.end('hello, world')
      })

      request(server)
      .get('/')
      .set('Accept-Encoding', 'gzip')
      .expect('Content-Encoding', 'gzip', done)
    })
  })

  describe('when "Accept-Encoding: deflate"', function () {
    it('should respond with deflate', function (done) {
      var server = createServer({ threshold: 0 }, function (req, res) {
        res.setHeader('Content-Type', 'text/plain')
        res.end('hello, world')
      })

      request(server)
      .get('/')
      .set('Accept-Encoding', 'deflate')
      .expect('Content-Encoding', 'deflate', done)
    })
  })

  describe('when "Accept-Encoding: gzip, deflate"', function () {
    it('should respond with gzip', function (done) {
      var server = createServer({ threshold: 0 }, function (req, res) {
        res.setHeader('Content-Type', 'text/plain')
        res.end('hello, world')
      })

      request(server)
      .get('/')
      .set('Accept-Encoding', 'gzip, deflate')
      .expect('Content-Encoding', 'gzip', done)
    })
  })

  describe('when "Accept-Encoding: deflate, gzip"', function () {
    it('should respond with gzip', function (done) {
      var server = createServer({ threshold: 0 }, function (req, res) {
        res.setHeader('Content-Type', 'text/plain')
        res.end('hello, world')
      })

      request(server)
      .get('/')
      .set('Accept-Encoding', 'deflate, gzip')
      .expect('Content-Encoding', 'gzip', done)
    })
  })

  describe('.filter', function () {
    it('should be a function', function () {
      assert.equal(typeof compression.filter, 'function')
    })

    it('should return false on empty response', function (done) {
      var server = http.createServer(function (req, res) {
        res.end(String(compression.filter(req, res)))
      })

      request(server)
      .get('/')
      .expect(200, 'false', done)
    })

    it('should return true for "text/plain"', function (done) {
      var server = http.createServer(function (req, res) {
        res.setHeader('Content-Type', 'text/plain')
        res.end(String(compression.filter(req, res)))
      })

      request(server)
      .get('/')
      .expect(200, 'true', done)
    })

    it('should return false for "application/x-bogus"', function (done) {
      var server = http.createServer(function (req, res) {
        res.setHeader('Content-Type', 'application/x-bogus')
        res.end(String(compression.filter(req, res)))
      })

      request(server)
      .get('/')
      .expect(200, 'false', done)
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
        assert.equal(res.headers['content-encoding'], 'gzip')
        res.on('data', write)
        res.on('end', function(){
          assert.equal(chunks, 2)
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
        assert.equal(res.headers['content-encoding'], 'gzip')
        res.on('data', write)
        res.on('end', function(){
          assert.equal(chunks, 20)
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
        assert.equal(res.headers['content-encoding'], 'deflate')
        res.on('data', write)
        res.on('end', function(){
          assert.equal(chunks, 20)
          done()
        })
      })
      .end()
    })
  })
})

function createServer(opts, fn) {
  var _compression = compression(opts)
  return http.createServer(function (req, res) {
    _compression(req, res, function (err) {
      if (err) {
        res.statusCode = err.status || 500
        res.end(err.message)
        return;
      }

      fn(req, res)
    })
  })
}

function shouldHaveBodyLength(length) {
  return function (res) {
    assert.equal(res.text.length, length, 'should have body length of ' + length)
  }
}

function shouldNotHaveHeader(header) {
  return function (res) {
    assert.ok(!(header.toLowerCase() in res.headers), 'should not have header ' + header)
  }
}
