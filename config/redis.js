'use strict';

const config = require('config');

const queueConfig = config.get('queue');
const connectionType = queueConfig.connectionType;
const redisConfig = queueConfig[`${connectionType}Connection`];
const connectionDetails = {
    redisOptions: {
        password: redisConfig.options && redisConfig.options.password,
        tls: redisConfig.options ? redisConfig.options.tls : false
    }
};

// for redisCluster config
if (connectionType === 'redisCluster') {
    connectionDetails.redisClusterHosts = redisConfig.hosts;
    connectionDetails.slotsRefreshTimeout = redisConfig.slotsRefreshTimeout;
    connectionDetails.clusterRetryStrategy = (times) => 100;
    connectionDetails.showFriendlyErrorStack = true;
} else {
    // for non-cluster redis config
    connectionDetails.redisOptions.host = redisConfig.host;
    connectionDetails.redisOptions.port = redisConfig.port;
    connectionDetails.redisOptions.database = redisConfig.database;
}

const queuePrefix = queueConfig.prefix || '';

const runningJobsPrefix = `${queuePrefix}running_job_`;
const waitingJobsPrefix = `${queuePrefix}waiting_job_`;

module.exports = {
    connectionDetails,
    queuePrefix,
    runningJobsPrefix,
    waitingJobsPrefix
};
