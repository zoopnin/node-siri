'use strict';

var tls = require('tls'),
    util = require('util'),
    zlib = require('zlib'),
    fs = require('fs'),
    Stream = require('stream'),

    parser = require("./parser"),
    bplist = require("./bplist"),
    SiriParser = parser.SiriParser,

    SIRI_SERVER = "17.151.230.4",
    //SIRI_SERVER = "17.174.8.5",
    SIRI_PORT = 443,
    SIRI_DEBUG = false;

function toArray(list) {
    return [].slice.call(list, 0);
}

function debug() {
    if (SIRI_DEBUG) return console.log.apply(console, toArray(arguments));
}

var id = 0;

function getId() {
    id++;
    return (id < 100 ? "0" : "") + (id < 10 ? "0" : "") + id;
}

function Server(options, commandListener) { // Server {{{
    if (!(this instanceof Server)) return new Server(options, commandListener);
    tls.Server.call(this, options);

    this.deviceMap = {};

    if (commandListener) {
        this.on("command", commandListener);
    }

    this.on("secureConnection", secureConnectionListener);
    this.on("clientError", function(err) {
        debug(err);
    });
}

util.inherits(Server, tls.Server);

Server.prototype.getDevice = function(key) {
    return this.deviceMap[key] = (this.deviceMap[key] || new SiriDevice());
};

Server.prototype.start = function(callback) {
    return this.listen(SIRI_PORT, callback);
};

exports.Server = Server;
exports.createServer = function(options, listener) {
    if (typeof options === "function") {
        listener = options;
        options = undefined;
    }

    options = options || {
        key: fs.readFileSync(__dirname + '/server-key.pem'),
        cert: fs.readFileSync(__dirname + '/server-cert.pem')
    };

    return Server(options, listener);
};

function secureConnectionListener(clientStream) {
    var self = this,

        // client -> clientStream -> clientParser -> serverCompressor -> server
        clientClosed = false,
        clientParser = new SiriParser(parser.SIRI_REQUEST),
        serverCompressor = null,

        // server -> serverStream -> serverParser -> clientCompressor -> client
        serverClosed = true,
        serverStream = tls.connect(SIRI_PORT, SIRI_SERVER, function() {
            serverClosed = false;
        }),
        serverParser = new SiriParser(parser.SIRI_RESPONSE),
        clientCompressor = null,
        device = null;

    function onClose() {
        if (clientClosed && serverClosed) {
            clientParser = null;
            serverCompressor = null;
            serverStream = null;
            serverParser = null;
            if (device) {
                device.serverStream = null;
                device.clientStream = null;
                device.commandHandler = null;
                device.answerHandler = null;
                device = null;
            }
        }
    }

    clientStream.pipe(serverStream);

    //解析请求得到设备 {{{
    clientStream.ondata = function(data, start, end) {
        clientParser.parse(data, start, end);
    };

    function onCommand(str) {
        self.emit("command", str, device);
    }

    clientParser.onAccept = function(pkg) {
        switch (pkg.getType()) {

            case parser.PKG_HTTP_HEADER:
                device = self.getDevice(pkg.headers["X-Ace-Host"]);
                break;

            case parser.PKG_HTTP_ACEHEADER:
                if (device) {
                    //服务端输出流压缩器
                    serverCompressor = zlib.createDeflate();
                    serverCompressor._flush = zlib.Z_SYNC_FLUSH;
                    serverCompressor.pipe(serverStream);
                    device.serverStream = serverCompressor;

                    //客户端输出流压缩器
                    clientCompressor = zlib.createDeflate();
                    clientCompressor._flush = zlib.Z_SYNC_FLUSH;
                    clientCompressor.pipe(clientStream);
                    device.clientStream = clientCompressor;

                    device.commandHandler = onCommand;
                    device.answerHandler = null;
                }
                break;

            case parser.PKG_ACE_PLIST:
                if (SIRI_DEBUG) {
                    var id = getId();
                    fs.writeFileSync("data/" + id + ".client.json", JSON.stringify(bplist.toPObject(pkg.rootNode())));
                    debug(id + ":" + bplist.toObject(pkg.rootNode())["class"]);
                }
                break;
            case parser.PKG_HTTP_UNKNOW:
            case parser.PKG_ACE_UNKNOW:
                break;
            default:
                self.emit("error", "Unknow package type:" + pkg.type + "!");
                break;
        }
    };

    function onClientEnd() {
        clientStream.removeListener("end", onClientEnd);
        clientStream.ondata = null;
        clientParser.onAccept = null;
        serverCompressor && serverCompressor.end();
        serverStream.end();
        device && (device.serverStream = null);
    }
    clientStream.on("end", onClientEnd);

    function onClientClose() {
        debug("onClientClose");
        clientStream.removeListener("close", onClientClose);
        clientClosed = true;
        onClose();
    }
    clientStream.on("close", onClientClose);
    // }}}

    //截获服务器信息 {{{
    serverStream.ondata = function(data, start, end) {
        serverParser.parse(data, start, end);
    };

    serverParser.onAccept = function(pkg) {
        switch (pkg.getType()) {
            case parser.PKG_HTTP_HEADER:
            case parser.PKG_HTTP_ACEHEADER:
            case parser.PKG_HTTP_UNKNOW:
                clientStream.write(pkg.getData());
                break;
            case parser.PKG_ACE_UNKNOW:
                clientCompressor.write(pkg.getData());
                break;
            case parser.PKG_ACE_PLIST:
                if (SIRI_DEBUG) {
                    var id = getId();
                    //fs.writeFileSync("data/" + id + ".server.bplist", pkg.getData().slice(5));
                    fs.writeFileSync("data/" + id + ".server.json", JSON.stringify(bplist.toPObject(pkg.rootNode())));
                    debug("\t" + id + ":" + bplist.toObject(pkg.rootNode())["class"]);
                }
                device && device.receivePackage(pkg);
                break;
            default:
                self.emit("error", "Unknow package type:" + pkg.type + "!");
                break;
        }
    };

    function onServerEnd() {
        serverStream.removeListener("end", onServerEnd);
        serverStream.ondata = null;
        serverParser.onAccept = null;
        clientCompressor && clientCompressor.end();
        device && (device.clientCompressor = null);
        clientStream.end();
    }
    serverStream.on("end", onServerEnd);

    function onServerClose() {
        debug("onServerClose");
        serverStream.removeListener("close", onServerClose);
        serverClosed = true;
        onClose();
    }
    serverStream.on("close", onServerClose);
    // }}}

    debug("Client connect.");
}
// }}}

function SiriDevice() { // Device {{{

    this.serverStream = null;
    this.clientStream = null;
    this.commandHandler = null;
    this.answerHandler = null;

    this.serverResponse = null;
    this.viewList = [];
    this.saying = false;
    this.asking = false;

    this.aceId = null;
    this.refId = null;
    this.version = null;
}

SiriDevice.prototype.onCommand = function(cmd) {
    this.commandHandler && this.commandHandler(cmd);
};

SiriDevice.prototype.onAnswer = function(answer) {
    this.answerHandler && this.answerHandler(answer);
};

SiriDevice.prototype.writeServer = function(pkg) {
    this.serverStream && this.serverStream.write(pkg.getData());
};

SiriDevice.prototype.writeClient = function(pkg) {
    this.clientStream && this.clientStream.write(pkg.getData());
};

SiriDevice.prototype.receivePackage = function(pkg) {
    var obj = bplist.toObject(pkg.rootNode()),
        text;

    this.refId = obj.refId;
    this.aceId = obj.aceId;
    this.version = obj.v;

    switch (obj["class"]) {
        case "SpeechRecognized":
            this.writeClient(pkg);

            text = getRecognizedText(obj);
            this.serverResponse = [];

            if (this.asking) {
                this.asking = false;
                this.onAnswer(text);
            } else {
                this.onCommand(text);
            }
            break;
        default:
            if (this.serverResponse) {
                this.serverResponse.push(pkg);
            } else {
                this.writeClient(pkg);
            }
            break;
    }
};

function getRecognizedText(obj) {
    var arr;
    if (obj["class"] != "SpeechRecognized") return null;
    arr = [];
    obj.properties.recognition.properties.phrases.forEach(function(item) {
        item.properties.interpretations[0].properties.tokens.forEach(function(item) {
            arr.push(item.properties.text);
        });
    });
    return arr.join("");
}

SiriDevice.prototype.getUtteranceView = function(str, speakable, listen) {
    return {
        "class": "string:AssistantUtteranceView",
        "properties": {
            //"dialogIdentifier": "string:Misc#answer",
            "speakableText": "unicode:" + (speakable === undefined ? str : speakable),
            "text": "unicode:" + str,
            "listenAfterSpeaking": "bool:" + (listen ? "true" : "false")
        },
        "group": "string:com.apple.ace.assistant"
    };
};

SiriDevice.prototype.addView = function(view) {
    var self = this;
    this.viewList.push(view);
    if (!this.saying) {
        this.saying = true;
        process.nextTick(function() {
            if (self.saying) {
                self.saying = false;
                self.flushViews();
            }
        });
    }
};

SiriDevice.prototype.flushViews = function() {
    this.writeClient(new parser.ACEBinaryPlist(bplist.fromPObject({
        "class": "string:AddViews",
        "properties": {
            "temporary": "bool:false",
            //"dialogPhase": "string:Completion",
            "scrollToTop": "bool:false",
            "views": this.viewList,
        },
        "v": "string:" + this.version,
        "refId": "string:" + this.refId,
        "aceId": "string:" + this.aceId,
        "group": "string:com.apple.ace.assistant"
    })));
    this.viewList = [];
};

SiriDevice.prototype.requestCompleted = function() {
    this.writeClient(new parser.ACEBinaryPlist(bplist.fromPObject({
        "class": "string:RequestCompleted",
        "properties": {
            "callbacks": []
        },
        "v": "string:" + this.version,
        "refId": "string:" + this.refId,
        "aceId": "string:" + this.aceId,
        "group": "string:com.apple.ace.system"
    })));
};

SiriDevice.prototype.proxy = function() {
    var self = this;
    if (this.serverResponse) {
        this.serverResponse.forEach(function(pkg, index) {
            self.writeClient(pkg);
        });
        this.serverResponse = null;
    }
};

SiriDevice.prototype.say = function(str, speakable) {
    this.addView(this.getUtteranceView(str, speakable, false));
};

SiriDevice.prototype.ask = function(str, speakable, callback) {
    if (typeof(speakable) != "string") {
        callback = speakable;
        speakable = undefined;
    }
    this.asking = true;
    this.answerHandler = callback;
    this.addView(this.getUtteranceView(str, speakable, true));
};

SiriDevice.prototype.end = function(str, speakable) {
    if (str !== undefined) this.say(str, speakable);
    this.saying = false;
    this.serverResponse = null;
    this.flushViews();
    this.requestCompleted();
    this.proxy();
};
// }}}

// vim600: sw=4 ts=4 fdm=marker syn=javascript
