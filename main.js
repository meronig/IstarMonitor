var fs = require('fs');
var xml2js = require('xml2js');
var Client = require('node-rest-client').Client;
var client = new Client();
var express = require('express');
var app = express();
app.use(express.static(__dirname));

var localPort = 8081;
var enginePort = 8083;
var engineHost = "localhost";
var tasks = {};
var goalModel = {};

const fulfilment = {
    UNKNOWN: 'unknown',
    SATISFIED: 'satisfied',
    DENIED: 'denied',
}

var goalModelPath = 'goalModel.xml';

if(process.argv.length > 2) {
	goalModelPath = process.argv[2];
}

if(process.argv.length > 4) {
	engineHost = process.argv[3];
    enginePort = process.argv[4];
}

if(process.argv.length > 5) {
    localPort = process.argv[5];
}

client.registerMethod("getEGSM", "http://"+engineHost+":"+enginePort+"/api/config_stages", "GET");

app.get('/api/getResults', function (req, res) {
    res.set('Content-Type', 'application/xml')
    res.end(saveResultsToADOxx());
})

app.get('/api/notifyStageOpened', function (req, res) {
    client.methods.getEGSM(function (data, response) {
        parseEGSMModel(data);
        console.log("data changed");
        console.log("stage " + req.query.stageName + " opened");
    });    
    res.end();
})

app.get('/api/notifyStageClosed', function (req, res) {
    client.methods.getEGSM(function (data, response) {
        parseEGSMModel(data);
        console.log("data changed");
        console.log("stage " + req.query.stageName + " closed");
    });    
    res.end();
})

var server = app.listen(localPort, function () {
  var port = server.address().port;
  console.log("Broker listening on port "+port);
})

readFile(goalModelPath);

function parseEGSMModel(egsm){

}

function readFile(mappingPath) {
    var parseString = xml2js.parseString;
     parseString(fs.readFileSync(mappingPath, 'utf8'), function (err, result) {
       //TODO, aggiungere la gestione dell'errore
       console.log('model parsed');
       goalModel = result;
       initTasksFromADOxx();
     });
}

function initTasksFromADOxx() {
	var instances = goalModel['ADOXML']['MODELS'][0]['MODEL'][0]['INSTANCE']
    
    for (var la in instances){
		if(instances[la]['$'].class == "Task"){
            tasks[instances[la]['$'].name] = fulfilment.UNKNOWN;
            console.log(instances[la]['$'].name);
        }
	}
}

function saveResultsToADOxx(){
    var instances = goalModel['ADOXML']['MODELS'][0]['MODEL'][0]['INSTANCE']
    //store updated values for goals
    for (var la in instances){
        if (tasks[instances[la]['$'].name] != null){
            for (at in instances[la]['ATTRIBUTE']) {
                if(instances[la]['ATTRIBUTE'][at]['$'].name == "State of fulfilment"){
                    instances[la]['ATTRIBUTE'][at]._ = tasks[instances[la]['$'].name];
                }
            }
        }
    }
    //build xml response compliant with ADOXML
    var builder = new xml2js.Builder({
        xmldec: {
        'version': '1.0',
        'encoding': 'UTF-8',
        'standalone': null
        },
        doctype: {
        'sysID': 'adoxml31.dtd'
        }});
    var xml = builder.buildObject(goalModel);
    return xml;
}
