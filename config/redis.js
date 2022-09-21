'use strict';

const config = require('config');

const queueConfig = config.get('queue');
const redisConfig = queueConfig.redisConnection;
const connectionDetails = {
    pkg: 'ioredis',
    host: redisConfig.host,
    options: {
        password: redisConfig.options && redisConfig.options.password,
        tls: redisConfig.options ? redisConfig.options.tls : false
    },
    port: redisConfig.port,
    database: redisConfig.database
};

// for redis-cluster config
if (redisConfig.hosts) {
    connectionDetails['hosts'] = redisConfig.hosts;
    connectionDetails['slotsRefreshTimeout'] = redisConfig.slotsRefreshTimeout;
    connectionDetails.options['clusterRetryStrategy'] = redisConfig.clusterRetryStrategy;
};

const queuePrefix = queueConfig.prefix || '';

const runningJobsPrefix = `${queuePrefix}running_job_`;
const waitingJobsPrefix = `${queuePrefix}waiting_job_`;

module.exports = {
    connectionDetails,
    queuePrefix,
    runningJobsPrefix,
    waitingJobsPrefix
};
