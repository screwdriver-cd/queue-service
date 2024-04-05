FROM node:18

# Screwdriver Version
ARG VERSION=latest

# Create our application directory
RUN mkdir -p /usr/src/app
WORKDIR /usr/src/app

# Install Screwdriver Queue Service
RUN npm install screwdriver-queue-service@$VERSION
WORKDIR /usr/src/app/node_modules/screwdriver-queue-service

# Setup configuration folder
# This layer is rebuilt when a file changes in the project directory
RUN cp -r /usr/src/app/node_modules/screwdriver-queue-service/config /config

# Expose the web service port
EXPOSE 8080

# Add dumb-init
RUN wget -O /usr/local/bin/dumb-init https://github.com/Yelp/dumb-init/releases/download/v1.2.5/dumb-init_1.2.5_x86_64
RUN chmod +x /usr/local/bin/dumb-init
ENTRYPOINT ["/usr/local/bin/dumb-init", "--"]

# Run the service
CMD [ "node", "./bin/server" ]
