var express = require('express')
var http = require('http')
var yargs = require('yargs')

var args = yargs(process.argv)
	.usage('Usage: $0 [options]')
	.option('c', {
  default: 'compression',
  choices: ['compression', 'shrink-ray', 'none'],
  describe: 'The compression middleware to use (compression or shrink-ray)'
	})
	.option('p', {
  default: 3000,
  describe: 'The port on which to serve the content'
	})
	.help('?')
	.alias('?', 'help')
	.argv

var app = express()

if (args.c !== 'none') app.use(require(args.c)({filter: function () { return true }}))
app.use(express.static('canterbury'))

var server = http.createServer(app)
server.listen(args.p, function () {
  console.log('Compressed Canterbury corpus app listening on port ' + args.p + ' with ' + args.c + ' middleware!')
})
