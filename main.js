var fs = require('fs');
var xml2js = require('xml2js');
var Client = require('node-rest-client').Client;
var client = new Client();
var express = require('express');
var app = express();
app.use(express.static(__dirname));

var localPort = 8082;
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
        parseEGSMModel(data,req.query.stageName,true);
        console.log("data changed");
        console.log("stage " + req.query.stageName + " opened");
    });    
    res.end();
})

app.get('/api/notifyStageClosed', function (req, res) {
    client.methods.getEGSM(function (data, response) {
        parseEGSMModel(data,req.query.stageName,false);
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

function parseEGSMModel(egsm,stageName,open){

    //stage is open
    var stage = locate(egsm,stageName);
    if(open){
        // check for skipped stages, and mark atomic stages inside them as denied
        for(var s in egsm){
            var substages = getSubStages(egsm[s]);
            for (var ss in substages){
                if (substages[ss].compliance == "skipped"){
                    markStage(substages[ss],fulfilment.DENIED);
                }
            }
        }
        // stage is atomic, if not already satisfied, mark it as such
        if (tasks[stageName]!=undefined){
            if (tasks[stageName]!=fulfilment.SATISFIED){
                tasks[stageName]=fulfilment.SATISFIED
            }
        // stage is composite
        } else {
            // stage represents a xor block, and is not inside a loop
            if(!isInsideLoop(egsm,stage) && isXor(stage)){
                {
                    console.log(stage.name + " is a xor");
                    //mark atomic stages inside branches not picked as denied
                    for(var s in stage.sub_stages){
                        for(var pfg in stage.sub_stages[s].processGuards){
                            if(stage.sub_stages[s].processGuards[pfg].value == false){
                                markStage(stage.sub_stages[s],fulfilment.DENIED);
                            }
                        }
                    }
                }
            }
        }
    // stage is closed
    } else {
        // stage represents a loop block, and is not inside another loop
        if(!isInsideLoop(egsm,stage) && isLoop(stage)){
            console.log(stage.name + " is a loop");
            //mark atomic stages inside loop as denied, if not already satisfied
            markStage(stage.sub_stages[0],fulfilment.DENIED);
        }
    }
}

function markStage(stage,value){
    var substages = getSubStages(stage);
    for(var s in substages){
        if(tasks[substages[s].name]==fulfilment.UNKNOWN){
            console.log("_"+substages[s].name);
            tasks[substages[s].name]=fulfilment.DENIED;
        }
    }
}

function getSubStages(stage){
    var stages = [stage];
    for (var s in stage.sub_stages){
        var substages = getSubStages(stage.sub_stages[s]);
        for (var ss in substages){
            stages.push(substages[ss]);
        }
    }
    return stages;
}

function locate(egsm,stageName){
    for (var s in egsm){
        if (egsm[s].name == stageName) {
            return egsm[s];
        } else {
            var substage = locate(egsm[s].sub_stages,stageName);
            if (substage!=null){
                return substage;
            }
        }
    }
    return null;
}

function isInsideLoop(egsm,stage){
    for (var s in egsm) {
        // is composite stage (and it can be a loop)
        if (egsm[s].sub_stages.length != 0){
            //is a loop
            if(isLoop(egsm[s])){
                // it contains stage
                if(locate(egsm[s].sub_stages,stage.name)!=null){
                    return true;
                }
            //is not a loop
            } else {
                //recursively invoke the function
                if(isInsideLoop(egsm[s].sub_stages,stage)){
                    return true;
                }
            }
        }
    }
    return false;
}

function isLoop(stage){
    if(/ExclusiveGateway.*/.test(stage.name)) {
        for (var s in stage.sub_stages){
            if(/.*iteration/.test(stage.sub_stages[s].name)) {
                return true;
            }
        }      
    }
    return false;
}

function isXor(stage){
    
    if(/ExclusiveGateway.*/.test(stage.name) && !/.*iteration/.test(stage.name)) {
        return !isLoop(stage);
    }
    return false;
}

function readFile(mappingPath) {
    var parseString = xml2js.parseString;
     parseString(fs.readFileSync(mappingPath, 'utf8'), function (err, result) {
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
