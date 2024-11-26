//Configuration files

module.exports = {
  processModelPath : 'data\\getService\\lhr-ams\\siena.xml',
  infoModelPath : 'data\\getService\\lhr-ams\\infoModel.xsd',
  port : 8083,
  feedbackEndpoint: 'http://127.0.0.1:8080/api/reset',
  feedbackEndpointOpen: 'http://istar-monitor:8082/api/notifyStageOpened',
  feedbackEndpointClose: 'http://istar-monitor:8082/api/notifyStageClosed'
}
