/*jslint node: true */
'use strict';
const constants = require('byteballcore/constants.js');
const conf = require('byteballcore/conf');
const db = require('byteballcore/db');
const eventBus = require('byteballcore/event_bus');
const validationUtils = require('byteballcore/validation_utils');
const headlessWallet = require('headless-byteball');
const request = require('request');
const correspondents = require('./correspondents');

let steps = {};
let assocDeviceAddressToCurrentCityAndTemp = {};
let assocDeviceAddressToAddress = {};
let bets = [];
let KEY_API = '50ace22603c84daba1780432180111';
let my_address;

eventBus.once('headless_wallet_ready', () => {
	headlessWallet.setupChatEventHandlers();
	
	headlessWallet.readSingleWallet(walletId => {
		db.query("SELECT address FROM my_addresses WHERE wallet=?", [walletId], function (rows) {
			if (rows.length === 0)
				throw Error("no addresses");
			my_address = rows[0].address;
		});
	});
	eventBus.on('paired', (from_address, pairing_secret) => {
		const device = require('byteballcore/device.js');
		device.sendMessageToDevice(from_address, 'text', "Welcome to my new shiny bot!");
	});
	
	eventBus.on('text', (from_address, text) => {
		text = text.trim().toLowerCase();
		if (!steps[from_address]) steps[from_address] = 'start';
		let step = steps[from_address];
		const device = require('byteballcore/device.js');
		if (validationUtils.isValidAddress(text.toUpperCase())) {
			assocDeviceAddressToAddress[from_address] = text.toUpperCase();
			return device.sendMessageToDevice(from_address, 'text', 'I saved your address. Send me the name of the city');
		} else if (!assocDeviceAddressToAddress[from_address]) {
			return device.sendMessageToDevice(from_address, 'text', 'Please send me your byteball address(... > Insert my address)');
		} else if (step === 'city' && (text === 'more' || text === 'less')) {
			let time = Date.now() + 20 * 60 * 1000;
			let name = assocDeviceAddressToCurrentCityAndTemp[from_address].city + '_' + time;
			let operator = text === 'more' ? '>=' : '<=';
			let value = assocDeviceAddressToCurrentCityAndTemp[from_address].temp;
			createContract(my_address, assocDeviceAddressToAddress[from_address], 2001, 2000, from_address, name, operator, value, time,
				(err, paymentRequestText, shared_address, timeout) => {
					if (err) throw err;
					findOracleAndSendMessage(assocDeviceAddressToCurrentCityAndTemp[from_address].city + ':' + time, () => {
						bets.push({
							myAmount: 2001,
							peerAmount: 2000,
							myAddress: my_address,
							peerAddress: assocDeviceAddressToAddress[from_address],
							sharedAddress: shared_address,
							peerDeviceAddress: from_address,
							name,
							operator,
							value,
							timeout
						});
						device.sendMessageToDevice(from_address, 'text', paymentRequestText);
						setTimeout(() => {
							headlessWallet.sendAllBytesFromAddress(shared_address, my_address, from_address, (err, unit) => {
								if (!err) console.error('unit:: ', unit);
							});
						}, 15 * 60 * 1000);
					});
				});
		} else if (step === 'start') {
			switch (text) {
				case 'berlin':
				case 'moscow':
				case 'helsinki':
				case 'washington':
					request('https://api.apixu.com/v1/current.json?key=' + KEY_API + '&q=' + text, function (error, response, body) {
						if (error) {
							console.error(error);
							device.sendMessageToDevice(from_address, 'text', 'An error occurred. Try again later.');
						} else {
							let result = JSON.parse(body);
							let temp = result.current.temp_c;
							device.sendMessageToDevice(from_address, 'text', 'Want to bet that in an hour the weather in ' + text + ' will be\n[more ' + temp + 'c](command:more) or [less ' + temp + 'c](command:less)?');
							steps[from_address] = 'city';
							assocDeviceAddressToCurrentCityAndTemp[from_address] = {city: text, temp};
						}
					});
					break;
				default:
					device.sendMessageToDevice(from_address, 'text', "City not support");
					break;
			}
		} else {
			device.sendMessageToDevice(from_address, 'text', "unknown command");
		}
	});
});

function createContract(myAddress, peerAddress, myAmount, peerAmount, peerDeviceAddress, name, operator, value, time, cb) {
	const device = require('byteballcore/device');
	let timeout = Date.now() + 10 * 60 * 1000;
	let inverseOperator = operator === '>=' ? '<' : '>';
	let arrSeenConditionPeer = ['seen', {
		what: 'output',
		address: 'this address',
		asset: 'base',
		amount: peerAmount
	}];
	let arrSeenConditionMyInput = ['seen', {
		what: 'input',
		address: 'this address',
		asset: 'base'
	}];
	let arrDefinition = ['or', [
		['or', [
			['and', [
				['address', peerAddress],
				arrSeenConditionPeer,
				arrSeenConditionMyInput
			]],
			['or', [
				['and', [
					['address', peerAddress],
					['in data feed', [[conf.oracle_address], name, operator, value]],
				]],
				['and', [
					['address', myAddress],
					['in data feed', [[conf.oracle_address], name, inverseOperator, value]]
				]]
			]],
		]],
		['and', [
			['address', myAddress],
			['not', arrSeenConditionPeer],
			['in data feed', [[conf.TIMESTAMPER_ADDRESS], 'timestamp', '>', timeout]]
		]]
	]];
	let assocSignersByPath = {
		'r.0.0.0': {
			address: peerAddress,
			member_signing_path: 'r',
			device_address: peerDeviceAddress
		}, 'r.0.1.0.0': {
			address: peerAddress,
			member_signing_path: 'r',
			device_address: peerDeviceAddress
		},
		'r.1.0': {
			address: myAddress,
			member_signing_path: 'r',
			device_address: device.getMyDeviceAddress()
		},
		'r.0.1.1.0': {
			address: myAddress,
			member_signing_path: 'r',
			device_address: device.getMyDeviceAddress()
		}
	};
	
	let walletDefinedByAddresses = require('byteballcore/wallet_defined_by_addresses.js');
	walletDefinedByAddresses.createNewSharedAddress(arrDefinition, assocSignersByPath, {
		ifError: (err) => {
			cb(err);
		},
		ifOk: (shared_address) => {
			headlessWallet.issueChangeAddressAndSendPayment('base', myAmount, shared_address, peerDeviceAddress, (err, unit) => {
				if (err) return cb(err);
				let arrPayments = [{
					address: shared_address,
					amount: peerAmount,
					asset: 'base'
				}];
				let assocDefinitions = {};
				assocDefinitions[shared_address] = {
					definition: arrDefinition,
					signers: assocSignersByPath
				};
				let objPaymentRequest = {payments: arrPayments, definitions: assocDefinitions};
				let paymentJson = JSON.stringify(objPaymentRequest);
				let paymentJsonBase64 = Buffer(paymentJson).toString('base64');
				let paymentRequestCode = 'payment:' + paymentJsonBase64;
				let paymentRequestText = '[your share of payment to the contract](' + paymentRequestCode + ')';
				cb(null, paymentRequestText, shared_address, timeout);
			});
		}
	});
}

function findOracleAndSendMessage(value, cb) {
	const device = require('byteballcore/device');
	correspondents.findCorrespondentByPairingCode(conf.oracle_pairing_code, (correspondent) => {
		if (!correspondent) {
			correspondents.addCorrespondent(conf.oracle_pairing_code, 'flight oracle', (err, device_address) => {
				if (err)
					throw new Error(err);
				device.sendMessageToDevice(device_address, 'text', value);
				cb();
			});
		} else {
			device.sendMessageToDevice(correspondent.device_address, 'text', value);
			cb();
		}
	});
}

process.on('unhandledRejection', up => { throw up; });
