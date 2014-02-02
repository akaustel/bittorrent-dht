// TODO:
// - Use the same DHT object for looking up multiple torrents
// - Persist the routing table for later bootstrapping
// - Use actual DHT data structure with "buckets" (follow spec)
// - Add the method that allows us to list ourselves in the DHT
// - https://github.com/czzarr/node-bitwise-xor

module.exports = DHT

var bencode = require('bncode')
var compact2string = require('compact2string')
var crypto = require('crypto')
var dgram = require('dgram')
var hat = require('hat')
var EventEmitter = require('events').EventEmitter
var inherits = require('inherits')

var MAX_NODES = 5000
var REQ_TIMEOUT = 2000
var MAX_REQUESTS = 3
var BOOTSTRAP_TIMEOUT = 5000
var BOOTSTRAP_NODES = [
  'dht.transmissionbt.com:6881',
  'router.bittorrent.com:6881',
  'router.utorrent.com:6881'
]

function parseNodeInfo (compact) {
  try {
    var nodes = []
    for (var i = 0; i < compact.length; i += 26) {
      nodes.push(compact2string(compact.slice(i + 20, i + 26)))
    }
    return nodes
  } catch (err) {
    console.warn('Invalid node info ' + compact)
    return []
  }
}

function parsePeerInfo (list) {
  try {
    return list.map(compact2string)
  } catch (err) {
    console.warn('Invalid peer info ' + list)
    return []
  }
}

inherits(DHT, EventEmitter)

/**
 * Create a new DHT
 * @param {string|Buffer} infoHash
 */
function DHT (infoHash) {
  if (!(this instanceof DHT)) return new DHT(infoHash)
  EventEmitter.call(this)

  this.infoHash = typeof infoHash === 'string'
    ? new Buffer(infoHash, 'hex')
    : infoHash

  this.nodes = {}
  this.peers = {}
  this.reqs = {}
  this.queue = [].concat(BOOTSTRAP_NODES)

  // Number of nodes we still need to find to satisfy the last call to findPeers
  this.missingPeers = 0

  this.nodeId = new Buffer(hat(160), 'hex')
  console.log('DHT node id: ' + this.nodeId.toString('hex'))

  this.requestId = 1
  this.pendingRequests = {}

  this.message = {
    t: this.requestId.toString(),
    y: 'q',
    q: 'get_peers',
    a: {
      id: this.nodeId,
      info_hash: this.infoHash
    }
  }
  // console.log('Created DHT message: ' + JSON.stringify(this.message))
  this.message = bencode.encode(this.message)

  this.pendingRequests[this.requestId] = 1

  this.socket = dgram.createSocket('udp4')
  this.socket.on('message', this._onData.bind(this))
}

DHT.prototype.close = function () {
  this.socket.unref()
  this.socket.close()

  this._closed = true
}

/**
 * Called when client finds a new DHT node
 * @param  {string} addr
 */
DHT.prototype._handleNode = function (addr) {
  if (this.nodes[addr]) {
    // console.log('already know about this node!')
    return
  }
  this.query(addr)
  // if (this.queue.length < 50) this.queue.push(addr) // TODO: remove this?

  this.emit('node', addr, this.infoHash.toString('hex'))
}

/**
 * Called when client finds a new peer
 * @param  {string} addr
 */
DHT.prototype._handlePeer = function (addr) {
  if (this.peers[addr]) return
  this.peers[addr] = true
  this.missingPeers = Math.max(0, this.missingPeers - 1)

  this.emit('peer', addr, this.infoHash.toString('hex'))
}

DHT.prototype._onData = function (data, rinfo) {
  var addr = rinfo.address + ':' + rinfo.port

  var message
  try {
    // console.log('got response from ' + addr)
    message = bencode.decode(data)
    if (!message) throw new Error('message is undefined')
  } catch (err) {
    console.error('Failed to decode data from node ' + addr + ' ' + err.message)
    return
  }

  if (!message.t || (message.t.toString() !== this.requestId.toString())) {
    // console.log('DHT received wrong message requestId: ', message.t && message.t.toString(), this.requestId && this.requestId.toString(), addr)
    return
  }

  // Mark that we've seen this node (the one we received data from)
  this.nodes[addr] = true
  delete this.reqs[addr]

  var r = message && message.r

  if (r && Buffer.isBuffer(r.nodes)) {
    // console.log('got nodes')
    parseNodeInfo(r.nodes).forEach(this._handleNode.bind(this))
  }
  if (r && Array.isArray(r.values)) {
    // console.log('got peers')
    parsePeerInfo(r.values).forEach(this._handlePeer.bind(this))
  }
}

DHT.prototype.query = function (addr) {
  var numNodes = Object.keys(this.nodes).length
  if (numNodes > MAX_NODES || this.missingPeers <= 0 || this._closed) return

  var host = addr.split(':')[0]
  var port = Number(addr.split(':')[1])
  this.socket.send(this.message, 0, this.message.length, port, host, function () {
    setTimeout(function () {
      this.reqs[addr] = (this.reqs[addr] || 0) + 1
      if (!this.nodes[addr] && this.reqs[addr] < MAX_REQUESTS) {
        this.query.call(this, addr);
      }
    }.bind(this), REQ_TIMEOUT)
  }.bind(this))
}

DHT.prototype.findPeers = function (num) {
  if (!num) num = 1

  // TODO: keep track of missing nodes for each `findPeers` call separately!
  this.missingPeers += num

  while (this.queue.length) {
    this.query(this.queue.pop())
  }

  // If we are connected to no nodes after timeout period, then retry with
  // the bootstrap nodes.
  setTimeout(function () {
    if (Object.keys(this.nodes).length === 0) {
      console.log('No DHT nodes replied, retry with bootstrap nodes')
      this.queue.push.apply(this.queue, BOOTSTRAP_NODES)
      this.missingPeers -= num
      this.findPeers(num)
    }
  }.bind(this), BOOTSTRAP_TIMEOUT)
}
