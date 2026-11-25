var fs = require('fs');
var xml2js = require('xml2js');
var Client = require('node-rest-client').Client;
var client = new Client();
var express = require('express');
var bodyParser = require('body-parser')
var conf          = require('./config/conf');
const { firstCharLowerCase } = require('xml2js/lib/processors');
var app = express();
app.use(function (req, res, next) {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    next();
});
app.use(express.static(__dirname));
app.use(bodyParser.text({ type: 'application/xml' }));

var nodes = {};
var connectors = {};
var goalModel = {};
var goalModelPath = conf.goalModelPath;

const fulfillment = {
    UNKNOWN: 'unknown',
    SATISFIED: 'satisfied',
    DENIED: 'denied',
    CONFLICT: 'conflict'
}

const nodeType = {
    GOAL: 'goal',
    TASK: 'task',
    QUALITY: 'quality',
    RESOURCE: 'resource',
    AGENT: 'agent',
    BOUNDARY: 'boundary'
}

const decomposition = {
    UNKNOWN: 'unknown',
    AND: 'AND',
    OR: 'OR',
    XOR: 'XOR'
}

if(process.argv.length > 2){
    var inputPort = process.argv[2];
}
if(process.argv.length > 3) {
	goalModelPath = process.argv[3];
}

// var inputPort = process.argv[2];
// configure web server
var port;
if(inputPort > 8000 && inputPort < 65536){
  port = process.env.PORT || inputPort;
}
else{
  port = process.env.PORT || conf.port;
}

client.registerMethod("getEGSM", conf.engineEndpoint, "GET");

app.get('/api/reset', function (req, res) {
    nodes = {};
    console.log(conf.goalModelPath);
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
    res.json(buildModelSnapshot());
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

app.post('/api/loadModel', function (req, res) { 
    const xml = req.body;
    xml2js.parseString(xml, function (err, result) {
            if (err) { 
                return res.status(400).send('Invalid XML format'); 
            } 
            console.log('model parsed');
            goalModel = result;
            initTasksFromADOxx();
            res.json(buildModelSnapshot()); 
        
    }); 
});

readFile(goalModelPath);

var server = app.listen(port, function () {
  var port = server.address().port;
  console.log("I-star monitor listening on port "+port);
})

function parseEGSMModel(egsm,stageName,open){

    //stage is open
    var changed = false;
    var stage = locate(egsm,stageName);
    if(open){
        // check for skipped stages, and mark atomic stages inside them as denied
        for(var s in egsm){
            var substages = getSubStages(egsm[s]);
            for (var ss in substages){
                if (substages[ss].compliance == "skipped"){
                    if (markStage(substages[ss],fulfillment.DENIED)){
                        changed = true;
                    }
                }
            }
        }
        // stage is atomic, if not already satisfied, mark it as such
        if (nodes[stageName]!=undefined){
            if (nodes[stageName].fulfillment!=fulfillment.SATISFIED){
                console.log('stage ' + stageName + ' set to ' + fulfillment.SATISFIED);
                nodes[stageName].fulfillment=fulfillment.SATISFIED;
                changed = true;
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
                                if (markStage(stage.sub_stages[s],fulfillment.DENIED)){
                                    changed = true;
                                }
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
            if (markStage(stage.sub_stages[0],fulfillment.DENIED)){
                changed = true;
            }
        }
    }
    if (changed) {
        propagateNew();
    }
}

function markStage(stage,value){
    var changed = false;
    var substages = getSubStages(stage);
    for(var s in substages){
        if(nodes[substages[s].name]!=undefined){
            if(nodes[substages[s].name].fulfillment==fulfillment.UNKNOWN){
                console.log('stage ' + substages[s].name + ' set to ' + fulfillment.DENIED);
                nodes[substages[s].name].fulfillment=fulfillment.DENIED;
                changed = true;
            }
        }
    }
    return changed;
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
       if (err) {
         console.error('Failed to parse goal model:', err);
         return;
       }
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
        } else if (instances[la]['$'].class == "Goal"){
            nodes[instances[la]['$'].name] = {fulfillment: fulfillment.UNKNOWN, nodeType: nodeType.GOAL, children: [], decomposition: decomposition.UNKNOWN};
        } else if(instances[la]['$'].class == "Softgoal"){
            nodes[instances[la]['$'].name] = {fulfillment: fulfillment.UNKNOWN, nodeType: nodeType.QUALITY, children: [], decomposition: decomposition.UNKNOWN};
        } else if (instances[la]['$'].class == "Resource"){
            nodes[instances[la]['$'].name] = {fulfillment: fulfillment.UNKNOWN, nodeType: nodeType.RESOURCE, children: [], decomposition: decomposition.UNKNOWN};
        } else if (instances[la]['$'].class == "Agent" || instances[la]['$'].class == "Actor" || instances[la]['$'].class == "Role") {
            nodes[instances[la]['$'].name] = {fulfillment: fulfillment.UNKNOWN, nodeType: nodeType.AGENT, children: [], decomposition: decomposition.UNKNOWN};
        } else if (instances[la]['$'].class == "Boundary"){
            nodes[instances[la]['$'].name] = {fulfillment: fulfillment.UNKNOWN, nodeType: nodeType.BOUNDARY, children: [], decomposition: decomposition.UNKNOWN};
        }
        if (nodes[instances[la]['$'].name]){
            nodes[instances[la]['$'].name].kind = instances[la]['$'].class;
            nodes[instances[la]['$'].name].position = getAttributeValue(instances[la], 'Position');
            nodes[instances[la]['$'].name].fulfillment = normalizeFulfillment(getAttributeValue(instances[la], 'State of fulfilment'));
            nodes[instances[la]['$'].name].satisfied = false;
            nodes[instances[la]['$'].name].denied = false;
        }
	}
    //connect nodes through edges
    var connectors = goalModel['ADOXML']['MODELS'][0]['MODEL'][0]['CONNECTOR'];

    for (var c in connectors){
        if (connectors[c]['$'].class == 'Decomposition Link') {
            nodes[connectors[c]['TO'][0]['$'].instance].children.push(connectors[c]['FROM'][0]['$'].instance);
            var attributes = connectors[c]['ATTRIBUTE'];
            for (var a in attributes) {
                if(attributes[a]['$'].name == 'Type of decomposition') {
                    nodes[connectors[c]['TO'][0]['$'].instance].decomposition = attributes[a]._
                }
            }
        }
        if (connectors[c]['$'].class == 'Dependency Link') {
            nodes[connectors[c]['FROM'][0]['$'].instance].children.push(connectors[c]['TO'][0]['$'].instance);
        }
        if (connectors[c]['$'].class == 'Contribution Link') {
            nodes[connectors[c]['TO'][0]['$'].instance].children.push(connectors[c]['FROM'][0]['$'].instance);
        }
    }
    
}

function getAttributeValue(instance, attributeName) {
    if (!instance || !instance.ATTRIBUTE) {
        return '';
    }

    var attribute = instance.ATTRIBUTE.find(function (entry) {
        return entry.$ && entry.$.name === attributeName;
    });

    return attribute ? (attribute._ || '') : '';
}

function getModelAttributeValue(model, attributeName) {
    var attributes = model && model.MODELATTRIBUTES ? model.MODELATTRIBUTES : [];
    var attributeEntry = null;

    for (var i = 0; i < attributes.length; i++) {
        var entries = attributes[i].ATTRIBUTE || [];
        for (var j = 0; j < entries.length; j++) {
            if (entries[j].$ && entries[j].$ .name === attributeName) {
                attributeEntry = entries[j];
                break;
            }
        }
        if (attributeEntry) {
            break;
        }
    }

    return attributeEntry ? (attributeEntry._ || '') : '';
}

function parseWorldArea(worldAreaText) {
    var match = (worldAreaText || '').match(/w:(-?\d+(?:\.\d+)?)cm\s+h:(-?\d+(?:\.\d+)?)cm/i);
    if (!match) {
        return { widthCm: 0, heightCm: 0 };
    }

    return {
        widthCm: parseFloat(match[1]),
        heightCm: parseFloat(match[2])
    };
}

function normalizeFulfillment(value) {
    var normalized = (value || '').toLowerCase();
    if (normalized === 'satisfied') {
        return fulfillment.SATISFIED;
    }
    if (normalized === 'denied') {
        return fulfillment.DENIED;
    }
    return fulfillment.UNKNOWN;
}

function buildModelSnapshot() {
    if (!goalModel || !goalModel['ADOXML'] || !goalModel['ADOXML']['MODELS'] || !goalModel['ADOXML']['MODELS'][0] || !goalModel['ADOXML']['MODELS'][0]['MODEL']) {
        return {
            instances: [],
            connectors: []
        };
    }

    var model = goalModel['ADOXML']['MODELS'][0]['MODEL'][0];
    var worldArea = parseWorldArea(getModelAttributeValue(model, 'World area'));
    var canvasWidth = Math.max(200, Math.round(worldArea.widthCm * 40));
    var canvasHeight = Math.max(200, Math.round(worldArea.heightCm * 40));
    var instances = (model.INSTANCE || []).map(function (instance) {
        var name = instance.$.name;
        var node = nodes[name] || {};
        return {
            id: instance.$.id,
            name: name,
            class: instance.$.class,
            position: node.position || '',
            fulfillment: node.fulfillment || fulfillment.UNKNOWN,
            satisfied: node.satisfied || false,
            denied: node.denied || false
        };
    });

    connectors = (model.CONNECTOR || [])
        .map(function (connector) {
            var from = connector.FROM && connector.FROM[0] && connector.FROM[0].$ ? connector.FROM[0].$ .instance : '';
            var to = connector.TO && connector.TO[0] && connector.TO[0].$ ? connector.TO[0].$ .instance : '';
            // for dependency links, the relation is reversed
            if (connector.$.class == 'Dependency Link') {
                var temp = from;
                from = to;
                to = temp;
            }

            var decomposition = '';
            var contribution = '';
            var attributes = connector.ATTRIBUTE || [];
            for (var a in attributes) {
                if (attributes[a].$ && attributes[a].$ .name === 'Type of decomposition') {
                    decomposition = attributes[a]._ || '';
                    break;
                } else if (attributes[a].$ && attributes[a].$ .name === 'Type of contribution') {
                    contribution = attributes[a]._ || '';
                    break;
                }
            }
            return {
                from: from,
                to: to,
                type: connector.$ ? connector.$.class : '',
                decomposition: decomposition,
                contribution: contribution
            };
        })
        .filter(function (connector) {
            return connector.from && connector.to && connector.type !== 'Is inside';
        });

    propagateNew();

    return {
        instances: instances,
        connectors: connectors,
        canvas: {
            width: canvasWidth,
            height: canvasHeight
        }
    };
}

function saveResultsToADOxx(){
    var instances = goalModel['ADOXML']['MODELS'][0]['MODEL'][0]['INSTANCE']
    //store updated values for goals
    for (var la in instances){
        console.log("updating " + instances[la]['$'].name + " to " + nodes[instances[la]['$'].name].fulfillment);
        if (nodes[instances[la]['$'].name] != null){
            for (at in instances[la]['ATTRIBUTE']) {
                if (instances[la]['ATTRIBUTE'][at]['$'].name == "State of fulfilment"){
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

function propagateNew(){

    // Add task nodes to the list of processed nodes
    var pendingNodes = new Set();
    for (var n in nodes) {
        if (nodes[n].nodeType === nodeType.TASK) {
            pendingNodes.add(n);
        }
    }
    console.log("Initial pending nodes (tasks):", Array.from(pendingNodes));

    while (pendingNodes.size > 0) {
        [first] = pendingNodes;
        pendingNodes.delete(first);
        var oldSatisfied = nodes[first].satisfied;
        var oldDenied = nodes[first].denied;
        propagateFulfillment(first);
        enforceRefinementLinks(first);
        enforceDependencyLinks(first);
        enforceContributionLinks(first);

        console.log("Processed node:", first, "satisfied:", nodes[first].satisfied, "denied:", nodes[first].denied);

        // values have changed
        if (nodes[first].satisfied != oldSatisfied || nodes[first].denied != oldDenied) {
            console.log("Node " + first + " changed: satisfied=" + nodes[first].satisfied + ", denied=" + nodes[first].denied);
            // add to the set all target elements of current one
            for (var c in connectors) {
                if (connectors[c].from == first) {
                    pendingNodes.add(connectors[c].to);
                }
            }
        }
    }

    deriveFulfillment();
}

function deriveFulfillment() {
    for (var n in nodes){
        if (!nodes[n].satisfied && !nodes[n].denied) {
            nodes[n].fulfillment = fulfillment.UNKNOWN;
        } else if (nodes[n].satisfied && !nodes[n].denied) {
            nodes[n].fulfillment = fulfillment.SATISFIED;
        } else if (!nodes[n].satisfied && nodes[n].denied) {
            nodes[n].fulfillment = fulfillment.DENIED;
        } else {
            nodes[n].fulfillment = fulfillment.CONFLICT;
        }
    }
}

// Maps to R1
function propagateFulfillment(node){
    if (!(nodes[node].nodeType == nodeType.TASK)) {
        return;
    }

    if (nodes[node].fulfillment == fulfillment.UNKNOWN){
        nodes[node].satisfied = false;
        nodes[node].denied = false;
    }

    if (nodes[node].fulfillment == fulfillment.SATISFIED){
        nodes[node].satisfied = true;
        nodes[node].denied = false;
    }

    if (nodes[node].fulfillment == fulfillment.DENIED){
        nodes[node].satisfied = false;
        nodes[node].denied = true;
    }

    if (nodes[node].fulfillment == fulfillment.CONFLICT){
        nodes[node].satisfied = true;
        nodes[node].denied = true;
    }
}

// Maps to R4 and R5
function enforceDependencyLinks(node) {
    // We assume that only one dependency link can exist for a node. Also, we ignore the value of the node.
    for (var c in connectors) {
        if (connectors[c].type == 'Dependency Link' && connectors[c].to == node) {
            nodes[node].satisfied = nodes[connectors[c].from].satisfied;
            nodes[node].denied = nodes[connectors[c].from].denied;
        }
    }
}

// Maps to R6
function enforceContributionLinks(node) {
    // We assume that the node has no dependency link
        
    if (!(nodes[node].nodeType == nodeType.QUALITY)) {
        return;
    }

    children = 0;
    satisfied = 0;
    denied = 0;
    for (var c in connectors) {
        if (connectors[c].type == 'Contribution Link' && connectors[c].to == node) {
            children++;
            if (connectors[c].contribution == 'Make' || connectors[c].contribution == 'Help') {
                if (nodes[connectors[c].from].satisfied) {
                    satisfied++;
                }
                if (nodes[connectors[c].from].denied) {
                    denied++;
                }
            } else {
                if (nodes[connectors[c].from].satisfied) {
                    denied++;
                }
                if (nodes[connectors[c].from].denied) {
                    satisfied++;
                }
            }
        }
    }

    if (children > 0) {
        if (satisfied > 0) {
            nodes[node].satisfied = true;
        } else {
            nodes[node].satisfied = false;
        }

        if (denied > 0) {
            nodes[node].denied = true;
        } else {
            nodes[node].denied = false;
        }
    }

}

// Maps to R2 and R3
function enforceRefinementLinks(task) {

    if (nodes[task].decomposition == decomposition.UNKNOWN) {
        return;
    }

    satisfied = 0;
    denied = 0;
    for (var c in nodes[task].children){
        if (nodes[nodes[task].children[c]].satisfied){
            satisfied++;
        } 
        if (nodes[nodes[task].children[c]].denied){
            denied++;
        }
    }

    if (nodes[task].decomposition == decomposition.AND) {
        if (denied > 0){
            nodes[task].denied = true;
        } else {
            nodes[task].denied = false;
        }
        if (satisfied == nodes[task].children.length) {
            nodes[task].satisfied = true;
        } else {
            nodes[task].satisfied = false;
        }
    } else {
        if (satisfied > 0){
            nodes[task].satisfied = true;
        } else {
            nodes[task].satisfied = false;
        }
        if (denied == nodes[task].children.length) {
            nodes[task].denied = true;
        } else {
            nodes[task].denied = false;
        }
    }

}