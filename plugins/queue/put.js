'use strict';

const logger = require('screwdriver-logger');
const scheduler = require('./scheduler');

module.exports = () => ({
    method: 'POST',
    path: '/queue/message',
    config: {
        description: 'Puts a message to the queue',
        notes: 'Should add a message to the queue',
        tags: ['api', 'queue'],
        auth: {
            strategies: ['token'],
            scope: ['sdapi']
        },
        handler: async (request, h) => {
            try {
                const executor = request.server.app.executorQueue;

                const { type } = request.query;

                switch (type) {
                    case 'periodic':
                        await scheduler.startPeriodic(executor, request.payload);
                        break;
                    case 'frozen':
                        await scheduler.startFrozen(executor, request.payload);
                        break;
                    case 'timer':
                        await scheduler.startTimer(executor, request.payload);
                        break;
                    case 'cache':
                        await scheduler.clearCache(executor, request.payload);
                        break;
                    case 'unzip':
                        await scheduler.unzipArtifacts(executor, request.payload);
                        break;
                    case 'webhook':
                        await scheduler.queueWebhook(executor, request.payload);
                        break;
                    default:
                        await scheduler.start(executor, request.payload);
                        break;
                }

                return h.response({}).code(200);
            } catch (err) {
                logger.error('Error in adding message to queue', err);

                throw err;
            }
        }
    }
});
