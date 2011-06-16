// Couch database
//
// I know maintenance will eventually have to be performed, like purging old documents.
// This is a place where it can go. Maybe in the future you can have dedicated maintenance
// nodes that don't interfere with the main API.
//
// Also, hopefully this file can be ported to browser Javascript and the same code can
// run client-side.

var lib = require('./lib')
  , util = require('util')
  , events = require('events')
  , assert = require('assert')
  , request = require('request')
  , querystring = require('querystring')
  ;

//
// Constants
//

var KNOWN_COUCHES = {};
var UUIDS         = {}; // Map couch URLs to UUID pools.
var UUID_BATCH_SIZE = 100;

//
// API
//

function Couch (opts) {
  var self = this;

  self.url     = (typeof opts.url === 'string') ? opts.url : null;
  self.userCtx = opts.userCtx || null;
  self.time_C  = opts.time_C  || null;

  self.known_dbs = {};

  self.log = lib.log4js().getLogger('Couch/' + self.url);
  self.log.setLevel(lib.LOG_LEVEL);
}

Couch.prototype.request = function(opts, callback) {
  var self = this;
  assert.ok(self.url);
  assert.ok(callback);

  if(typeof opts === 'string')
    opts = {'uri':opts};
  opts.uri = self.url + '/' + opts.uri;
  opts.time_C = opts.time_C || self.time_C;

  self.confirmed(function(er) {
    if(er) return callback(er);

    var method = opts.method || 'GET';
    self.log.debug(method + ' ' + opts.uri);
    return lib.req_json(opts, callback);
  })
}

Couch.prototype.uuid = function get_uuid(count, callback) {
  var self = this;
  if(typeof count === 'function') {
    callback = count;
    count = 1;
  }

  var uuids = uuids_for(self);
  return uuids.get(count, callback);
}

Couch.prototype.confirmed = function confirm_couch(cb) {
  var self = this;
  assert.ok(cb);
  assert.ok(self.url);

  if(self.userCtx && self.known_dbs)
    return cb();

  var state = KNOWN_COUCHES[self.url];

  if(state && state.userCtx && state.known_dbs) {
    self.log.debug('Confirmation was cached: ' + self.url);
    self.userCtx = state.userCtx;
    self.known_dbs = state.known_dbs;
    return cb();
  }

  if(!state) {
    state = KNOWN_COUCHES[self.url] = new events.EventEmitter;
    state.known_dbs = self.known_dbs;
    self.log.debug('Initialized known_dbs for ' + self.url);

    function emit(er, resp) { state.emit('done', er, resp) }

    // Don't use self.request because that calls confirmed().
    self.log.debug('Confirming Couch: ' + self.url);
    lib.req_json({uri:self.url, time_C:self.time_C}, function(er, resp, body) {
      if(er) return emit(er);

      if(body.couchdb !== 'Welcome')
        return emit(new Error('Bad CouchDB response from ' + self.url));

      self.log.debug('Confirming session');
      lib.req_json({uri:self.url+'/_session', time_C:self.time_C}, function(er, resp, session) {
        if(er) return emit(er);

        if(!session.userCtx)
          return emit(new Error('Bad CouchDB response from ' + session_url));
        self.log.debug('Couch confirmed: ' + self.url + ': ' + lib.JS(session.userCtx));

        //self.log.debug('Calling back: ' + util.inspect(session.userCtx));
        state.userCtx = session.userCtx;
        return emit(null);
      })
    })
  }

  state.on('done', function(er, userCtx) {
    if(er) return cb(er);
    cb();
  })
}

function Database (opts) {
  var self = this;

  if(typeof opts.couch !== 'string')
    throw new Error('Required "couch" option with URL of CouchDB');

  opts.db = opts.db || "";
  if(typeof opts.db !== 'string')
    throw new Error('Optional "db" option must be string');

  self.name   = opts.db;
  self.couch  = new Couch({'url':opts.couch, time_C:opts.time_C});
  self.secObj = null;

  self.log = lib.log4js().getLogger('DB/' + self.name);
  self.log.setLevel(process.env.cqs_log_level || "info");
}


Database.prototype.request = function(opts, callback) {
  var self = this;

  if(typeof opts === 'string')
    opts = {'uri':opts};
  opts.uri = self.name + '/' + opts.uri;

  self.confirmed(function(er) {
    if(er) return callback(er);

    self.couch.request(opts, callback);
  })
}


Database.prototype.confirmed = function(cb) {
  var self = this;
  assert.ok(cb);
  assert.ok(self.couch);

  if(self.secObj)
    return cb();

  self.couch.confirmed(function() {
    var state = self.couch.known_dbs[self.name];
    if(state && state.secObj) {
      self.log.debug('Confirmation was cached: ' + lib.JS(self.name));
      self.secObj = state.secObj;
      return cb();
    }

    if(!state) {
      state = self.couch.known_dbs[self.name] = new events.EventEmitter;
      function emit(er, resp) { state.emit('done', er, resp) }

      self.log.debug('Confirming DB: ' + self.name);
      self.couch.request(self.name, function(er, resp, db) {
        if(er) return emit(er);

        if(db.db_name !== self.name)
          return emit(new Error('Expected DB name "'+self.name+'": ' + db.db_name));

        self.log.debug('Checking _security: ' + self.name);
        self.couch.request(self.name+'/_security', function(er, resp, secObj) {
          if(er) return emit(er);

          if(!secObj)
            return emit(new Error('Bad _security response from ' + self.name + ': ' + lib.JS(secObj)));

          self.log.debug('Confirmed DB: ' + self.name + ': ' + lib.JS(secObj));
          state.secObj = secObj;
          return emit(null);
        })
      })
    }

    state.on('done', function(er, secObj) {
      if(er) return cb(er);
      return cb();
    })
  })
}

module.exports = { "Database" : Database
                 };


//
// Utilities
//

function uuids_for(couch) {
  if(UUIDS[couch.url])
    return UUIDS[couch.url];

  var getter = UUIDS[couch.url] = new events.EventEmitter;
  getter.couch = couch;
  getter.pool = [];
  getter.fetching = false;

  getter.get = function(count, callback) {
    var self = this;
    var response;

    if(count <= self.pool.length) {
      // Just send back the UUIDs.
      response  = self.pool.slice(0, count);
      self.pool = self.pool.slice(count + 1);

      if(response.length === 1)
        response = response[0];

      return callback(null, response);
    } else {
      // Fetch some more.
      self.fetch();
      self.on('error', function(er) { callback(er) });
      self.on('batch', function() {
        // A new batch came in. Re-run.
        return self.get(count, callback);
      })
    }
  }

  getter.fetch = function() {
    var self = this;
    if(self.fetching)
      return;

    self.fetching = true;
    self.couch.request('_uuids?count='+UUID_BATCH_SIZE, function(er, resp, result) {
      self.fetching = false;
      if(er)
        return self.emit('error', er);

      if(!result.uuids || result.uuids.length !== UUID_BATCH_SIZE)
        return self.emit('error', new Error('Unknown _uuids result: ' + lib.JS(result)));

      self.pool = self.pool.concat(result.uuids);
      self.emit('batch');
    })
  }

  return getter;
}
