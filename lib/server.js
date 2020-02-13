'use strict';

const Hapi = require('@hapi/hapi');
const plugins = require('./registerPlugins');
const logger = require('screwdriver-logger');

/**
 * If we're throwing errors, let's have them say a little more than just 500
 * @method prettyPrintErrors
 * @param  {Hapi.Request}    request Hapi Request object
 * @param  {Hapi.Reply}      reply   Hapi Reply object
 */
function prettyPrintErrors(request, reply) {
    if (request.response.isBoom) {
        const err = request.response;
        const errName = err.output.payload.error;
        const errMessage = err.message;
        const statusCode = err.output.payload.statusCode;
        const stack = err.stack || errMessage;

        if (statusCode === 500) {
            request.log(['server', 'error'], stack);
        }

        const response = {
            statusCode,
            error: errName,
            message: errMessage
        };

        if (err.data) {
            response.data = err.data;
        }

        return reply(response).code(statusCode);
    }

    return reply.continue();
}

module.exports = async (config) => {
    try {
        const server = Hapi.Server({
            port: config.httpd.port,
            host: config.httpd.host,
            uri: config.httpd.uri,
            routes: {
                log: { collect: true }
            },
            router: {
                stripTrailingSlash: true
            }
        });

        // Write prettier errors
        server.ext('onPreResponse', prettyPrintErrors);

        await plugins(server, config);

        await server.start();
        logger.info('Server running on %s', server.info.uri);
    }
    catch (err) {
        logger.error(`Error in starting server ${err}`)
    }
};

process.on('unhandledRejection', (err) => {
    console.log(err);
    process.exit(1);
});