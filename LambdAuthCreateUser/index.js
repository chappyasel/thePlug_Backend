console.log('Loading function');

// dependencies
var AWS = require('aws-sdk');
var crypto = require('crypto');
var util = require('util');
var config = require('./config.json');

// Get reference to AWS clients
var dynamodb = new AWS.DynamoDB();
var ses = new AWS.SES();
var lambda = new AWS.Lambda();

function computeHash(password, salt, fn) {
	// Bytesize
	var len = 128;
	var iterations = 4096;

	if (3 == arguments.length) {
		crypto.pbkdf2(password, salt, iterations, len, fn);
	} else {
		fn = salt;
		crypto.randomBytes(len, function(err, salt) {
			if (err) return fn(err);
			salt = salt.toString('base64');
			crypto.pbkdf2(password, salt, iterations, len, function(err, derivedKey) {
				if (err) return fn(err);
				fn(null, salt, derivedKey.toString('base64'));
			});
		});
	}
}

function storeUser(email, username, password, salt, fn) {
	// Bytesize
	var len = 128;
	var infoTable = config.DDB_TABLE + 'Info';
	var detailTable = config.DDB_TABLE + 'Detail';
	crypto.randomBytes(len, function(err, token) {
		if (err) return fn(err);
		token = token.toString('hex');
		dynamodb.putItem({
			TableName: config.DDB_TABLE,
			Item: {
				email: { S: email },
				passwordHash: { S: password },
				passwordSalt: { S: salt },
				username: { S: username },
				verified: { BOOL: false },
				verifyToken: { S: token }
			},
			ConditionExpression: 'attribute_not_exists (email)'
		}, function(err, data) {
			if (err) return fn(err);
			else { 
				fn(null, token);
				//user info + detail creation
				dynamodb.putItem({
					TableName: infoTable,
					Item: {
						username: { S: username },
						name: { S: username}
					},
					ConditionExpression: 'attribute_not_exists (username)'
				}, function(err, data) {
					if (err) return fn(err);
					else fn(null, token);
				});
				dynamodb.putItem({
					TableName: detailTable,
					Item: {
						username: { S: username },
						//profileImage: { S: ''} //need to add default profile image
					},
					ConditionExpression: 'attribute_not_exists (username)'
				}, function(err, data) {
					if (err) return fn(err);
					else fn(null, token);
				});
			}
		});
	});
}

function sendVerificationEmail(email, token, fn) {
	var subject = 'Verification Email for ' + config.EXTERNAL_NAME;
	var verificationLink = config.VERIFICATION_PAGE + '?email=' + encodeURIComponent(email) + '&verify=' + token;
	ses.sendEmail({
		Source: config.EMAIL_SOURCE,
		Destination: {
			ToAddresses: [
				email
			]
		},
		Message: {
			Subject: {
				Data: subject
			},
			Body: {
				Html: {
					Data: '<html><head>'
					+ '<meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />'
					+ '<title>' + subject + '</title>'
					+ '</head><body>'
					+ 'Please <a href="' + verificationLink + '">click here to verify your email address</a> or copy & paste the following link in a browser:'
					+ '<br><br>'
					+ '<a href="' + verificationLink + '">' + verificationLink + '</a>'
					+ '</body></html>'
				}
			}
		}
	}, fn);
}

exports.handler = function(event, context) {
	var email = event.email;
	var clearPassword = event.password;
	var username = event.username;	

	computeHash(clearPassword, function(err, salt, hash) {
		if (err) {
			context.fail('Error in hash: ' + err);
		} else {
			storeUser(email, username, hash, salt, function(err, token) {
				if (err) {
					if (err.code == 'ConditionalCheckFailedException') {
						// userId already found
						context.succeed({ created: false });
					} else { context.fail('Error in storeUser: ' + err); }
				} else {
					sendVerificationEmail(email, token, function(err, data) {
						if (err) {
							context.fail('Error in sendVerificationEmail: ' + err);
						} else { //create fully succeded
							var payload = {
        						email: email,
        						password: event.password
      						};
							lambda.invoke({
 								FunctionName: 'LambdAuthLogin',
  								Payload: JSON.stringify(payload) // pass params
							}, function(err, data) {
					  			if (err) {  context.fail('login error in createUser', err, err.stack);  }
 								else { 
									var output = JSON.parse(data.Payload);
									context.succeed({
										created: true,
										login: output.login,
										identityId: output.identityId,
										token: output.token, 
										username:  output.username
									}); 
								}
								context.fail('unknown login error in createUser'); 
							});
							//context.fail('login funtion not called error'); 
							//context.succeed({
							//		created: true
							//});
						}
					});
				}
			});
		}
	});
}
