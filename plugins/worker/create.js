'use strict';

const logger = require('screwdriver-logger');
const worker = require('./worker');

module.exports = () => ({
    method: 'POST',
    path: '/queue/worker',
    config: {
        description: 'Start worker to read and process messages from the queue',
        notes: 'Should start worker to process messages from the queue',
        tags: ['api', 'queue'],
        auth: {
            strategies: ['token'],
            scope: ['sdapi']
        },
        handler: async (request, h) => {
            try {
                const result = await worker.invoke(request);

                return h.response(result).code(200);
            } catch (err) {
                logger.error(`Failed to start worker ${err}`);

                return h.response({ Error: err.message }).code(500);
            }
        }
    }
});
