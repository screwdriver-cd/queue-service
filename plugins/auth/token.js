'use strict';

const boom = require('@hapi/boom');
const schema = require('screwdriver-data-schema');

/**
 * Generate a new JSON Web Token
 * @method token
 * @return {Object}  Hapi Plugin Route
 */
module.exports = () => ({
    method: ['GET'],
    path: '/auth/token/{buildId?}',
    config: {
        description: 'Generate jwt',
        notes: 'Generate a JWT for calling other microservices',
        tags: ['api', 'auth', 'token'],
        auth: {
            strategies: ['token'],
            scope: ['temporal']
        },
        handler: async (request, h) => {
            try {
                let profile = request.auth.credentials;
                const username = profile.username;
                const scope = profile.scope;
                const token = profile.token;

                // Check Build ID impersonate
                if (request.params.buildId) {
                    if (!scope.includes('temporal')) {
                        return reply(boom.forbidden(`User ${username} cannot generate token`));
                    }
                    profile = request.server.plugins.auth.generateProfile(
                        request.params.buildId,
                        request.params.scmContext,
                        ['user']
                    );
                    profile.token = request.server.plugins.auth.generateToken(profile);

                    request.cookieAuth.set(profile);

                    return h.response({ token: profile.token }).code(200);
                }

                return h.response({ token });
            } catch (err) {
                return h.response(boom.boomify(err));
            }
        },
        response: {
            schema: schema.api.auth.token
        }
    }
});
