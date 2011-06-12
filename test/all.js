// The changes_couchdb command-line interface.
//

var COUCH = 'http://localhost:5984';
var DB    = 'cqs_test';

if(process.env.charles)
  COUCH = 'http://jhs-mac.local:15984';
  //COUCH = 'http://192.168.3.10:15984';

var cqs = require('../api').defaults({'couch':COUCH, 'db':DB})
  , util = require('util'), I = util.inspect
  , assert = require('assert')
  , request = require('request')
  ;

var state = {};
module.exports = [ // TESTS

function setup(done) {
  var url = COUCH + '/' + DB;
  request({method:'DELETE', uri:url}, function(er, resp, body) {
    if(er) throw er;
    var json = JSON.parse(body);

    var already_gone = (resp.statusCode === 404 && json.error === 'not_found');
    var deleted      = (resp.statusCode === 200 && json.ok    === true);

    if(! (already_gone || deleted))
      throw new Error('Unknown DELETE response: ' + resp.statusCode + ' ' + body);

    request({method:'PUT', uri:url}, function(er, resp, body) {
      if(er) throw er;
      var json = JSON.parse(body);

      if(resp.statusCode !== 201 || json.ok !== true)
        throw new Error('Unknown PUT response: ' + resp.statusCode + ' ' + body);

      done();
    })
  })
},

// =-=-=-=-=-=-=-=-=

function create_queue(done) {
  cqs.CreateQueue('foo', function(er, queue) {
    if(er) return done(er);
    assert.equal(queue.name, 'foo', "CreateQueue returns the queue name");
    state.foo = queue;
    done();
  })
},

function create_queue_with_obj(done) {
  cqs.CreateQueue({name:'bar', DefaultVisibilityTimeout:111}, function(er, queue) {
    if(er) return done(er);
    assert.equal(queue.name, 'bar', "CreateQueue returns the queue name");
    assert.equal(queue.VisibilityTimeout, 111, "Created with visibility 111");
    state.bar = queue;
    done();
  })
},

function instantiate_queue_loads_from_couch(done) {
  var should_be_bar = new cqs.Queue('bar');
  should_be_bar.confirm(function(er) {
    if(er) throw er;
    assert.equal(should_be_bar.VisibilityTimeout, 111, "Should get bar's visibility timeout");
    assert.equal(should_be_bar.VisibilityTimeout, state.bar.VisibilityTimeout, "Should get bar's visibility timeout");
    done();
  })
},

function list_queues(done) {
  cqs.ListQueues(function(er, queues) {
    if(er) throw er;
    assert.equal(2, queues.length);

    assert.any(queues, "Queue list should include foo", function(q) { return q.name == 'foo' });
    assert.any(queues, "Queue list should include bar", function(q) { return q.name == 'bar' });
    done();
  })
},

function list_queues_with_prefix(done) {
  cqs.ListQueues('f', function(er, queues) {
    if(er) throw er;
    assert.equal(1, queues.length);

    function is_foo(q) { return q.name == 'foo' }
    function is_bar(q) { return q.name == 'bar' }

    assert.none(queues, "Queues should not have bar", is_bar);
    assert.any(queues , "Queues should have foo"    , is_foo);

    cqs.ListQueues('b', function(er, queues) {
      if(er) throw er;
      assert.equal(1, queues.length);
      assert.none(queues, "Queues should not have foo", is_foo);
      assert.any(queues , "Queues should have bar"    , is_bar);
      done();
    })
  })
},

function send_message(done) {
  state.bar.send('Message one', function(er, msg) {
    if(er) throw er;

    // TODO: confirm MD5.

    ; ["Body", "MD5OfMessageBody", "MessageId"].forEach(function(key) {
      assert.ok(key in msg, "SendMessage result needs key: " + key);
    })

    assert.equal(msg.Body, 'Message one', "Message body should be what was sent");

    state.message_one = msg;
    done();
  })
},

function receive_no_message(done) {
  cqs.ReceiveMessage(state.foo, function(er, messages) {
    if(er) throw er;

    assert.equal(messages.length, 0, 'Foo queue should not have any messages yet');
    done();
  })
},

function receive_message(done) {
  state.bar.receive(function(er, messages) {
    if(er) throw er;

    assert.equal(messages.length, 1, 'Bar queue should have message from earlier');
    var msg = messages[0];
    assert.equal(msg.Body, state.message_one.Body, "Message should be message one's body");
    assert.equal(msg.Body, 'Message one'         , "Message should be message one's body");

    done();
  })
},

function set_queue_attribs(done) {
  cqs.SetQueueAttributes(state.foo, {'VisibilityTimeout':0.5}, function(er) {
    if(er) throw er;

    assert.equal(state.foo.VisibilityTimeout, 0.5, "Foo should have 0.5 second visibility now");
    new cqs.Queue('foo').confirmed(function(er, foo2) {
      if(er) throw er;

      assert.equal(foo2.VisibilityTimeout, state.foo.VisibilityTimeout, "Both foos should be 0.5");
      assert.equal(foo2.VisibilityTimeout,                         0.5, "Both foos should be 0.5");

      done();
    })
  })
},

function make_sure_new_message_has_the_attributes(done) {
  cqs.SendMessage(state.foo, "Should be 0.5 visibility timeout", function(er) {
    if(er) throw er;
    var now = new Date;
    cqs.ReceiveMessage(state.foo, function(er, msg) {
      if(er) throw er;
      msg = msg[0];

      var invisible_ms = msg.visible_at - now;
      assert.almost(invisible_ms, 500, "Invisible (should be 500): " + invisible_ms);

      state.half_sec = msg;
      done();
    })
  })
},

function send_message_api(done) {
  cqs.SendMessage('foo', 'API with string arg', function(er) {
    if(er) throw er;
    cqs.SendMessage(state.foo, 'API with queue arg', function(er) {
      if(er) throw er;
      state.foo.send('queue method call', function(er) {
        if(er) throw er;
        done();
      })
    })
  })
},

function receive_message_api(done) {
  cqs.ReceiveMessage('foo', function(er, msg) {
    if(er) throw er;
    assert.equal(msg[0].Body, 'API with string arg', 'Messages should arrive in order');
    cqs.ReceiveMessage(state.foo, function(er, msg) {
      if(er) throw er;
      assert.equal(msg[0].Body, 'API with queue arg', 'Messages should arrive in order');
      state.foo.receive(function(er, msg) {
        if(er) throw er;
        assert.equal(msg[0].Body, 'queue method call', 'Messages should arrive in order');
        done();
      })
    })
  })
},

{'timeout': 1000},
function delete_message(done) {
  var now = new Date;
  var vis_at = state.half_sec.visible_at;
  assert.ok(vis_at);
  assert.ok(vis_at - now > 0, "Too late to run this test: " + (now - state.half_sec.visible_at));

  cqs.DeleteMessage(state.half_sec, function(er) {
    if(er) throw er;

    function check() {
      cqs.ReceiveMessage('foo', function(er, msg) {
        if(er) throw er;
        assert.equal(msg.length, 0, "Should be no more messages left");
        done();
      })
    }

    var remaining = vis_at - (new Date);
    if(remaining < 0)
      check();
    else
      setTimeout(check, remaining + 50);
  })
},

function get_queue_attributes(done) {
  cqs.GetQueueAttributes('bar', function(er, attrs) {
    if(er) throw er;

    assert.equal(attrs.VisibilityTimeout, state.bar.VisibilityTimeout, "Should be bar's visibility timeout");
    assert.equal(attrs.VisibilityTimeout,                         111, "Should be bar's visibility timeout");

    cqs.GetQueueAttributes(state.foo, '--force', ['all'], function(er, attrs) {
      if(er) throw er;

      assert.equal(attrs.VisibilityTimeout, state.foo.VisibilityTimeout, "Should be bar's visibility timeout");
      assert.equal(attrs.VisibilityTimeout,                         0.5, "Should be bar's visibility timeout");

      done();
    })
  })
},

] // TESTS