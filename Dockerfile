FROM quay.io/qasimtech/-BREAKER:latest

WORKDIR /root/mega-md

RUN git clone https://github.com/Biharkebahubali/CODE-BREAKER-BOT . && \
    npm install

EXPOSE 5000

CMD ["npm", "start"]
