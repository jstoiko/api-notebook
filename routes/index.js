var express = require('express');
var app     = module.exports = express();

app.use('/auth',  require('./auth'));
app.use('/gists', require('./gists'));
