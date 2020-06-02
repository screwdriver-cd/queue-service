'use strict';

const logger = require('screwdriver-logger');
const scheduler = require('./scheduler');

module.exports = () => ({
    method: 'DELETE',
    path: '/queue/message',
    config: {
        description: 'Deletes a message to the queue',
        notes: 'Should delete a message from the queue',
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
                        await scheduler.stopPeriodic(executor, request.payload);
                        break;
                    case 'frozen':
                        await scheduler.stopFrozen(executor, request.payload);
                        break;
                    case 'timer':
                        await scheduler.stopTimer(executor, request.payload);
                        break;
                    default:
                        await scheduler.stop(executor, request.payload);
                        break;
                }

                return h.response({}).code(200);
            } catch (err) {
                logger.error('Error in removing message from queue', err);

                throw err;
            }
        }
    }
});
