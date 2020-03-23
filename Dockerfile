FROM node:12

# Screwdriver Version
ARG VERSION=latest

# Create our application directory
RUN mkdir -p /usr/src/app
WORKDIR /usr/src/app

# Install Screwdriver Queue Service
RUN npm install screwdriver-queue-service@$VERSION
WORKDIR /usr/src/app/node_modules/screwdriver-queue-service

# Setup configuration folder
RUN ln -s /usr/src/app/node_modules/screwdriver-queue-service/config /config

# Expose the web service port
EXPOSE 8080

# Run the service
CMD [ "npm", "start" ]
