'use strict';

const config = require('config');

const queueConfig = config.get('queue');
const redisConfig = queueConfig.redisConnection;
const connectionDetails = {
    pkg: 'ioredis',
    host: redisConfig.host,
    options: {
        password: redisConfig.options.password,
        tls: redisConfig.options.tls
    },
    port: redisConfig.port,
    database: 0
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
