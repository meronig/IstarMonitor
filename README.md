# IstarMonitor
A goal monitoring engine using the I-star 2.0 language, to complement artifact-driven process monitoring.

## Prerequisites
PASO E-GSM process monitoring engine: https://bitbucket.org/polimiisgroup/egsmengine/src/master/

## Deployment with Docker

* Clone PASO repository and generate PASO docker image:

```
git clone https://bitbucket.org/polimiisgroup/egsmengine.git
cd egsmengine
docker-compose create
```

* Clone this repository, generate and deploy Docker images:

```
git clone https://github.com/meronig/IstarMonitor.git
cd IstarMonitor
docker-compose create
docker-compose start
```

* With a web browser, go to the following URLs using different windows or tabs:

  * http://localhost:1880 to access Node-RED (to replay sensor data logs used for validation) page

  * http://localhost:8082 to access the goal monitoring engine page

  * http://localhost:8083 to access the process monitoring engine page

* Try replaying one of the sensor data logs used to validate the approach:

  * From Node-RED UI, choose the tab corresponding to the scenario you want to replay (e.g., LHR-AMS truck sensor log)

  * From that tab, choose the node representing the sensor data log you want to replay (e.g., 110) and click to the square to the left)

  * By going to the goal monitoring engine page, you should see the I-star model of that process with goals and tasks dynamically changing color, depending on the current value.

  * By going to the process monitoring engine page, you should see the E-GSM model of that process with stages dynamically changing color, depending on the current value.

* Before trying to execute another log, make sure to wait a couple of minutes to ensure that all events from the previous log have been processed. Also, make sure to refresh the process monitoring engine page after you start replaying a different log.
