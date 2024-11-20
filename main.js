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
var nodes = {};
var goalModel = {};

const fulfillment = {
    UNKNOWN: 'unknown',
    SATISFIED: 'satisfied',
    DENIED: 'denied'
}

const nodeType = {
    GOAL: 'goal',
    TASK: 'task'
}

const decomposition = {
    UNKNOWN: 'unknown',
    AND: 'AND',
    OR: 'OR',
    XOR: 'XOR'
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

app.get('/api/reset', function (req, res) {
    nodes = {};
    readFile(goalModelPath);
    console.log("model resetted");
    res.end();
})

app.get('/api/getResults', function (req, res) {
    res.set('Content-Type', 'application/xml');
    res.end(saveResultsToADOxx());
})

app.get('/api/getResultsAsFile', function (req, res) {
    
    res.set('Content-Type', 'application/xml');
    res.set('Content-Disposition', 'attachment;filename=model.xml');
    res.end(saveResultsToADOxx());
})


app.get('/api/getStatus', function (req, res) {
    res.end(JSON.stringify(nodes));
})

app.get('/api/notifyStageOpened', function (req, res) {
    client.methods.getEGSM(function (data, response) {
        console.log("data changed");
        console.log("stage " + req.query.stageName + " opened");
        parseEGSMModel(data,req.query.stageName,true);
    });    
    res.end();
})

app.get('/api/notifyStageClosed', function (req, res) {
    client.methods.getEGSM(function (data, response) {
        console.log("data changed");
        console.log("stage " + req.query.stageName + " closed");
        parseEGSMModel(data,req.query.stageName,false);
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
                    markStage(substages[ss],fulfillment.DENIED);
                }
            }
        }
        // stage is atomic, if not already satisfied, mark it as such
        if (nodes[stageName]!=undefined){
            if (nodes[stageName].fulfillment!=fulfillment.SATISFIED){
                console.log('stage ' + stageName + ' set to ' + fulfillment.SATISFIED);
                nodes[stageName].fulfillment=fulfillment.SATISFIED;
                propagate(stageName);
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
                                markStage(stage.sub_stages[s],fulfillment.DENIED);
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
            markStage(stage.sub_stages[0],fulfillment.DENIED);
        }
    }
}

function markStage(stage,value){
    var substages = getSubStages(stage);
    for(var s in substages){
        if(nodes[substages[s].name]!=undefined){
            if(nodes[substages[s].name].fulfillment==fulfillment.UNKNOWN){
                console.log('stage ' + substages[s].name + ' set to ' + fulfillment.DENIED);
                nodes[substages[s].name].fulfillment=fulfillment.DENIED;
                propagate(substages[s].name);
            }
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
	//create nodes
    var instances = goalModel['ADOXML']['MODELS'][0]['MODEL'][0]['INSTANCE'];
    
    for (var la in instances){
		if(instances[la]['$'].class == "Task"){
            nodes[instances[la]['$'].name] = {fulfillment: fulfillment.UNKNOWN, nodeType: nodeType.TASK, children: [], decomposition: decomposition.UNKNOWN};
            //console.log(instances[la]['$'].name);
        } else if (instances[la]['$'].class == "Goal"){
            nodes[instances[la]['$'].name] = {fulfillment: fulfillment.UNKNOWN, nodeType: nodeType.GOAL, children: [], decomposition: decomposition.UNKNOWN};
            //console.log(instances[la]['$'].name);
        }
	}
    //connect nodes through edges
    var connectors = goalModel['ADOXML']['MODELS'][0]['MODEL'][0]['CONNECTOR'];

    for (var c in connectors){
        if (connectors[c]['$'].class == 'Decomposition Link') {
            //console.log(nodes[connectors[c]['FROM'][0]['$'].instance].children);
            nodes[connectors[c]['TO'][0]['$'].instance].children.push(connectors[c]['FROM'][0]['$'].instance);
            var attributes = connectors[c]['ATTRIBUTE'];
            for (var a in attributes) {
                if(attributes[a]['$'].name == 'Type of decomposition') {
                    //console.log(attributes[a]._);
                    nodes[connectors[c]['TO'][0]['$'].instance].decomposition = attributes[a]._
                }
            }
        }
    }
    
}

function saveResultsToADOxx(){
    var instances = goalModel['ADOXML']['MODELS'][0]['MODEL'][0]['INSTANCE']
    //store updated values for goals
    for (var la in instances){
        if (nodes[instances[la]['$'].name] != null){
            for (at in instances[la]['ATTRIBUTE']) {
                if(instances[la]['ATTRIBUTE'][at]['$'].name == "State of fulfillment"){
                    instances[la]['ATTRIBUTE'][at]._ = nodes[instances[la]['$'].name].fulfillment;
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

function propagate(task){
    for (var n in nodes){
        if(nodes[n].children.includes(task)){
            //compute fulfillment
            deriveFulfillment(n);
            propagate(n);
        }
    }
}

function deriveFulfillment(task) {
    unknown = 0;
    satisfied = 0;
    denied = 0;
    console.log(nodes[task]);
    for (var c in nodes[task].children){
        if (nodes[nodes[task].children[c]].fulfillment == fulfillment.SATISFIED){
            satisfied++;
        } else if (nodes[nodes[task].children[c]].fulfillment == fulfillment.UNKNOWN){
            unknown++;
        } else if (nodes[nodes[task].children[c]].fulfillment == fulfillment.DENIED){
            denied++;
        }
    }
    console.log('node ' + task);
    console.log('decomposition ' + nodes[task].decomposition);
    console.log('satisfied = ' + satisfied);
    console.log('denied = ' + denied);
    console.log('unknown = ' + unknown);
    console.log();

    if (nodes[task].decomposition == decomposition.AND){
        if (denied == 0 && unknown == 0){
            nodes[task].fulfillment = fulfillment.SATISFIED;
        } else if (denied > 0) {
            nodes[task].fulfillment = fulfillment.DENIED;
        } else {
            nodes[task].fulfillment = fulfillment.UNKNOWN;
        }
    } else if (nodes[task].decomposition == decomposition.OR) {
        if (satisfied == 0 && unknown == 0){
            nodes[task].fulfillment = fulfillment.DENIED;
        } else if (satisfied > 0) {
            nodes[task].fulfillment = fulfillment.SATISFIED;
        } else {
            nodes[task].fulfillment = fulfillment.UNKNOWN;
        }
    } else if (nodes[task].decomposition == decomposition.XOR) {
        if(satisfied == 1 && unknown == 0) {
            nodes[task].fulfillment = fulfillment.SATISFIED;
        } else if (satisfied > 1 || (satisfied == 0 && unknown == 0)){
            nodes[task].fulfillment = fulfillment.DENIED;
        } else {
            nodes[task].fulfillment = fulfillment.UNKNOWN;
        }
    }

    /*
    if (decomposition == decomposition.AND){
        satisfied = true;
        for (var c in nodes[task].children){
            if (nodes[c].fulfillment == fulfillment.DENIED){
                nodes[task].fulfillment = fulfillment.DENIED;
                return;
            } else if (nodes[c].fulfillment == fulfillment.UNKNOWN){
                satisfied = false;
            }
        }
        if(satisfied){
            nodes[task].fulfillment = fulfillment.SATISFIED;
        } else {
            nodes[task].fulfillment = fulfillment.UNKNOWN;
        }
    } else if (decomposition == decomposition.OR){
        denied = true;
        for (var c in nodes[task].children){
            if (nodes[c].fulfillment == fulfillment.SATISFIED){
                nodes[task].fulfillment = fulfillment.SATISFIED;
                return;
            } else if (nodes[c].fulfillment == fulfillment.UNKNOWN){
                denied = false;
            }
        }
        if(denied){
            nodes[task].fulfillment = fulfillment.DENIED;
        } else {
            nodes[task].fulfillment = fulfillment.UNKNOWN;
        }
    } else if (decomposition == decomposition.XOR){
        unknown = 0;
        satisfied = 0;
        for (var c in nodes[task].children){
            if (nodes[c].fulfillment == fulfillment.SATISFIED){
                satisfied++;
            } else if (nodes[c].fulfillment == fulfillment.UNKNOWN){
                unknown++;
            }
        }
        if(satisfied == 1 && unknown == 0) {
            nodes[task].fulfillment = fulfillment.SATISFIED;
        } else if (satisfied > 1 || (satisfied == 0 && unknown == 0)){
            nodes[task].fulfillment = fulfillment.DENIED;
        } else {
            nodes[task].fulfillment = fulfillment.UNKNOWN;
        }
    }
    */
}