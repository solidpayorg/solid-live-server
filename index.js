#!/usr/bin/env node

const WebSocket = require('ws')
const WebSocketServer = require('ws').Server
const fs = require('fs')
const uuid = require('uuid')
const handler = require('serve-handler')
const https = require('https')
const INotifyWait = require('inotifywait')
const parallel = require('run-parallel')
const url = require('url')

const port = 3001

const server = https.createServer({
  cert: fs.readFileSync('./fullchain.pem'),
  key: fs.readFileSync('./privkey.pem')
},
(request, response) => {
  // You pass two more arguments for config and middleware
  // More details here: https://github.com/zeit/serve-handler#options
  return handler(request, response, {
    public: 'public',
    'renderSingle': true
  })
})

WsServer(server)

server.listen(port, () => {
  console.log('Running at https://localhost:' + port)
})

function defaultToChannel (iri) {
  return url.parse(iri).path
}

function WsServer (server, opts) {
  var self = this

  opts = opts || {}
  this.suffix = opts.suffix || '.changes'
  this.store = opts.store || new InMemory(opts)
  var toChannel = opts.toChannel || defaultToChannel

  publish = function (iri, callback) {
    this.store.get(iri, function (err, subscribers) {
      if (err) {
        if (callback) return callback(err)
        else return
      }

      if (!subscribers) {
        subscribers = {}
      }

      console.log('publish', 'subscribers', subscribers, 'iri', iri)

      var tasks = Object.keys(subscribers)
        .map(function (uuid) {
          return function (cb) {
            var client = subscribers[uuid][0]
            var channel = subscribers[uuid][1]
            console.log('pub ' + channel + ' to ' + client.uuid)
            client.send('pub ' + channel)
          }
        })

      parallel(tasks, callback)
    })
  }

  // Starting WSS server
  var wss = new WebSocketServer({
    server: server,
    clientTracking: false,
    path: opts.path
  })

  var watch1 = new INotifyWait('./public/', { recursive: false })
  watch1.on('ready', function (filename) {
    console.log('watcher is watching')
  })
  watch1.on('change', function (filename) {
    console.log(filename + ' change')
    self.publish(filename)
  })
  watch1.on('add', function (filename) {
    console.log(filename + ' added')
  })

  // Handling a single connection
  wss.on('connection', function (client) {
    console.log('New connection')
    // var location = url.parse(client.upgradeReq.url, true)

    // Handling messages
    client.on('message', function (message) {
      console.log('New message: ' + message)

      if (!message || typeof message !== 'string') {
        return
      }

      var tuple = message.split(' ')
      var command = tuple[0]
      var iri = tuple[1]

      // Only accept 'sub http://example.tld/hello'
      if (tuple.length < 2 || command !== 'sub') {
        return
      }

      var channel = toChannel ? toChannel(iri) : iri
      self.store.subscribe(channel, iri, client, function (err, uuid) {
        if (err) {
          // TODO Should return an error
          return
        }

        console.log('ack ' + tuple[1])
        client.send('ack ' + tuple[1])
      })
    })

    // Respond to ping
    client.on('ping', function () {
      client.pong()
    })
  })
}

function InMemory (opts) {
  opts = opts || {}
  this.uris = opts.uris || {}
  this.subscribers = opts.subscribers || {}
}

InMemory.prototype.subscribe = function (channel, uri, client, callback) {
  var self = this

  if (!this.subscribers[channel]) {
    this.subscribers[channel] = {}
  }

  if (!client.uuid) {
    client.uuid = uuid.v1()
  }

  this.subscribers[channel][client.uuid] = [client, uri]
  console.log('subscribers', this.subscribers)

  client.on('close', function () {
    delete self.subscribers[channel][client.uuid]
  })

  return callback(null, client.uuid)
}

InMemory.prototype.get = function (channel, callback) {
  return callback(null, this.subscribers[channel] || {})
}
