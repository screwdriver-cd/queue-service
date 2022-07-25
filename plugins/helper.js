'use strict';

const request = require('screwdriver-request');
const logger = require('screwdriver-logger');
const { queuePrefix } = require('../config/redis');

const RETRY_LIMIT = 3;
const RETRY_DELAY = 5;
const calculateDelay = ({ computedValue }) => (computedValue ? RETRY_DELAY * 1000 : 0); // in ms

/**
 * Callback function to retry when HTTP status code is not 2xx
 * @param   {Object}    response
 * @param   {Function}  retryWithMergedOptions
 * @return  {Object}    response
 */
function requestRetryStrategy(response) {
    if (Math.floor(response.statusCode / 100) !== 2) {
        throw new Error('Retry limit reached');
    }

    return response;
}

/**
 * Callback function to retry when HTTP status code is not 2xx and 404
 * @param   {Object}    response
 * @param   {Function}  retryWithMergedOptions
 * @return  {Object}    response
 */
function requestRetryStrategyPostEvent(response) {
    if (Math.floor(response.statusCode / 100) !== 2 && response.statusCode !== 404) {
        throw new Error('Retry limit reached');
    }

    return response;
}

/**
 *
 * @param {String} method
 * @param {String} uri
 * @param {String} token
 * @param {Function} retryStrategyFn
 * @param {Object} body
 */
function formatOptions(method, url, token, json, retryStrategyFn) {
    const options = {
        method,
        url,
        headers: {
            Authorization: `Bearer ${token}`
        }
    };

    if (json) {
        Object.assign(options, { json });
    }
    if (retryStrategyFn) {
        const retry = {
            limit: RETRY_LIMIT,
            calculateDelay
        };

        if (method === 'POST') {
            Object.assign(retry, {
                methods: ['POST']
            });
        }

        Object.assign(options, {
            retry,
            hooks: {
                afterResponse: [retryStrategyFn]
            }
        });
    }

    logger.info(`${options.method} ${options.url}`);

    return options;
}

/**
 * Update build status
 * @method updateBuildStatus
 * @param  {Object}  updateConfig build config of the job
 * @return {Promise}
 */
async function updateBuildStatus(updateConfig) {
    const { redisInstance, status, statusMessage, buildId } = updateConfig;

    const buildConfig = await redisInstance.hget(`${queuePrefix}buildConfigs`, buildId).then(JSON.parse);

    if (!buildConfig) return null;

    return request(
        formatOptions('PUT', `${buildConfig.apiUri}/v4/builds/${buildId}`, buildConfig.token, {
            status,
            statusMessage
        })
    ).then(res => {
        if (res.statusCode === 200) {
            return res.body;
        }

        logger.error(`PUT /v4/builds/${buildId} returned non 200, ${res.statusCode}, ${res.body}`);

        throw new Error(`Failed to updateBuildStatus with ${res.statusCode} code and ${res.body}`);
    });
}

/**
 * Updates the step with code and end time
 * @method updateStepStop
 * @param {Object} stepConfig
 * @param {Object} stepConfig.redisInstance
 * @param {String} stepConfig.buildId
 * @param {String} stepConfig.stepName
 * @param {Integer} stepConfig.code
 * @return {Promise} response body or error
 */
async function updateStepStop(stepConfig) {
    const { redisInstance, buildId, stepName, code } = stepConfig;
    const buildConfig = await redisInstance.hget(`${queuePrefix}buildConfigs`, buildId).then(JSON.parse);

    // if buildConfig got deleted already, do not update
    if (!buildConfig) return null;

    return request(
        formatOptions('PUT', `${buildConfig.apiUri}/v4/builds/${buildId}/steps/${stepName}`, buildConfig.token, {
            endTime: new Date().toISOString(),
            code
        })
    ).then(res => {
        if (res.statusCode === 200) {
            return res.body;
        }

        logger.error(`PUT /v4/builds/${buildId}/steps/${stepName} returned non 200, ${res.statusCode}, ${res.body}`);

        throw new Error(`Failed to updateStepStop with ${res.statusCode} code and ${res.body}`);
    });
}

/**
 * Gets the current active step in the build
 * @method getCurrentStep
 * @param {Object} stepConfig
 * @param {Object} stepConfig.redisInstance
 * @param {String} stepConfig.buildId
 * @return {Promise} active step or error
 */
async function getCurrentStep(stepConfig) {
    const { redisInstance, buildId } = stepConfig;
    const buildConfig = await redisInstance.hget(`${queuePrefix}buildConfigs`, buildId).then(JSON.parse);

    // if buildConfig got deleted already, do not update
    if (!buildConfig) return null;

    return request(
        formatOptions('GET', `${buildConfig.apiUri}/v4/builds/${buildId}/steps?status=active`, buildConfig.token)
    ).then(res => {
        if (res.statusCode === 200) {
            if (res.body && res.body.length > 0) {
                return res.body[0];
            }

            return null;
        }

        logger.error(`PUT /v4/builds/${buildId}/steps?status=active returned non 200, ${res.statusCode}, ${res.body}`);

        throw new Error(`Failed to getCurrentStep with ${res.statusCode} code and ${res.body}`);
    });
}

/**
 *
 * @param {String} apiUri
 * @param {Object} eventConfig
 * @param {Object} buildEvent
 * @param {Function} retryStrategyFn
 */
async function createBuildEvent(apiUri, token, buildEvent, retryStrategyFn) {
    return request(formatOptions('POST', `${apiUri}/v4/events`, token, buildEvent, retryStrategyFn)).then(res => {
        logger.info(
            `POST /v4/events/${buildEvent.buildId} completed with attempts, ${res.statusCode}, ${res.attempts}`
        );
        if (res.statusCode === 201) {
            return res;
        }

        logger.info(
            `POST /v4/events/${buildEvent.buildId} returned non 201, ${res.statusCode}, ${JSON.stringify(res.body)}`
        );

        if (res.statusCode === 200) {
            return JSON.stringify(res.body);
        }

        throw new Error(JSON.stringify(res.body));
    });
}

/**
 *
 * @param {String} apiUri
 * @param {String} pipelineId
 * @param {Function} retryStrategyFn
 */
async function getPipelineAdmin(token, apiUri, pipelineId, retryStrategyFn) {
    return request(
        formatOptions('GET', `${apiUri}/v4/pipelines/${pipelineId}/admin`, token, undefined, retryStrategyFn)
    ).then(res => {
        logger.info(
            `POST /v4/pipelines/${pipelineId}/admin completed with attempts, ${res.statusCode}, ${res.attempts}`
        );
        if (res.statusCode === 200) {
            return res.body;
        }

        throw new Error(`No pipeline admin found with ${res.statusCode} code and ${JSON.stringify(res.body)}`);
    });
}

/**
 *
 * @param {String} buildId
 * @param {String} token
 * @param {Object} payload
 * @param {String} apiUri
 * @param {Object} updateConfig
 */
async function updateBuild(updateConfig, retryStrategyFn) {
    const { buildId, token, payload, apiUri } = updateConfig;

    return request(formatOptions('PUT', `${apiUri}/v4/builds/${buildId}`, token, payload, retryStrategyFn)).then(
        res => {
            logger.info(`PUT /v4/builds/${buildId} completed with attempts, ${res.statusCode}, ${res.attempts}`);
            if (res.statusCode === 200) {
                return res.body;
            }

            throw new Error(`Build not updated with ${res.statusCode}code and ${JSON.stringify(res.body)}`);
        }
    );
}

/**
 *
 * @param {String} pipelineId
 * @param {String} token
 * @param {Object} payload
 * @param {String} apiUri
 * @param {Object} retryStrategyFn
 */
 async function notifyPipeline(token, apiUri, pipelineId, payload, retryStrategyFn) {
    return request(formatOptions('POST', `${apiUri}/v4/pipelines/${pipelineId}/notify`, token, payload, retryStrategyFn)).then(
        res => {
            logger.info(`POST /v4/pipelines/${pipelineId}/notify completed with attempts, ${res.statusCode}, ${res.attempts}`);
            if ([200, 201, 204].includes(res.statusCode)) {
                return res;
            }

            throw new Error(`Could not notify pipeline ${pipelineId} with ${res.statusCode}code and ${JSON.stringify(res.body)}`);
        }
    );
}

/**
 * Post the webhooks process
 * @method processHooks
 * @param {String} apiUri
 * @param {String} token
 * @param {String} webhookConfig as JSON format
 * @param {Function} retryStrategyFn
 * @return {Promise} response or error
 */
async function processHooks(apiUri, token, webhookConfig) {
    const options = {
        method: 'POST',
        url: `${apiUri}/v4/processHooks`,
        headers: {
            Authorization: `Bearer ${token}`
        },
        json: webhookConfig,
        retry: {
            limit: RETRY_LIMIT,
            calculateDelay,
            methods: ['POST']
        },
        // Do not retry if the request is received
        errorCodes: ['EADDRINUSE', 'ECONNREFUSED', 'ENOTFOUND', 'ENETUNREACH', 'EAI_AGAIN']
    };

    return request(options)
        .then(res => {
            logger.info(`POST /v4/processHooks completed, ${res.statusCode}, ${JSON.stringify(res.body)}`);
            if ([200, 201, 204].includes(res.statusCode)) {
                return res;
            }

            throw new Error(`Failed to process webhook with ${res.statusCode} code and ${res.body}`);
        })
        .catch(err => {
            if (err.code === 'ETIMEDOUT') {
                logger.info(`POST /v4/processHooks timed out.`);
                const res = {
                    statusCode: 504,
                    message: `POST /v4/processHooks timed out.`
                };

                return res;
            }

            throw err;
        });
}

module.exports = {
    requestRetryStrategy,
    requestRetryStrategyPostEvent,
    updateBuildStatus,
    updateStepStop,
    getCurrentStep,
    createBuildEvent,
    getPipelineAdmin,
    updateBuild,
    notifyPipeline,
    processHooks
};
