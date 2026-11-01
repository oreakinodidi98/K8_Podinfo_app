FROM node:22-alpine
WORKDIR /app
LABEL com.azure.containerizationassist.createdby="containerization-assist"
ENV NODE_ENV=production PORT=8080
COPY --chown=node:node package.json server.js ./
COPY --chown=node:node public ./public
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(e => { console.error(e.message); process.exit(1); })"
USER node
CMD ["node", "server.js"]
