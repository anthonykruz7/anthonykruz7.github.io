const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class MockContract {
    constructor() {
        this.ledgerFile = path.join(__dirname, 'mock_ledger.json');
        this.loadLedger();
    }

    loadLedger() {
        try {
            if (fs.existsSync(this.ledgerFile)) {
                const data = fs.readFileSync(this.ledgerFile, 'utf8');
                this.ledger = JSON.parse(data);
            } else {
                this.ledger = {
                    universities: {},
                    credentials: {}
                };
                this.saveLedger();
            }
        } catch (e) {
            console.error("Error reading mock ledger, resetting...", e);
            this.ledger = {
                universities: {},
                credentials: {}
            };
        }
    }

    saveLedger() {
        try {
            fs.writeFileSync(this.ledgerFile, JSON.stringify(this.ledger, null, 2), 'utf8');
        } catch (e) {
            console.error("Failed to save mock ledger:", e);
        }
    }

    async submit(name, options) {
        const args = options.arguments;
        this.loadLedger();
        if (name === 'RegisterUniversity') {
            const [uniName, pubKeyHex] = args;
            this.ledger.universities[uniName] = {
                name: uniName,
                publicKey: pubKeyHex
            };
            this.saveLedger();
            console.log(`[MOCK LEDGER]: Registered university "${uniName}" with public key: ${pubKeyHex}`);
        } else if (name === 'IssueCredential') {
            const [credentialID, studentPubKey, pdfHash, issuerSignature, ipfsCid, issuerName] = args;
            this.ledger.credentials[credentialID] = {
                credentialID,
                studentPubKey,
                pdfHash,
                issuerSignature,
                ipfsCID: ipfsCid, // Map correctly to what evaluate expects
                ipfsCid,
                issuerName
            };
            this.saveLedger();
            console.log(`[MOCK LEDGER]: Issued credential "${credentialID}" for student: ${studentPubKey}`);
        }
        return Buffer.from("SUCCESS");
    }

    async evaluate(name, options) {
        const args = options.arguments;
        this.loadLedger();
        if (name === 'QueryCredential') {
            const [credentialID] = args;
            const record = this.ledger.credentials[credentialID];
            if (!record) {
                throw new Error(`Credential ${credentialID} not found on Mock Ledger`);
            }
            return Buffer.from(JSON.stringify(record));
        } else if (name === 'QueryUniversity') {
            const [uniName] = args;
            const record = this.ledger.universities[uniName];
            if (!record) {
                throw new Error(`University ${uniName} not found on Mock Ledger`);
            }
            return Buffer.from(JSON.stringify(record));
        }
        throw new Error(`Unknown chaincode function: ${name}`);
    }
}

class MockGateway {
    close() {
        console.log("[MOCK GATEWAY]: Closed gateway connection.");
    }
}

class MockClient {
    close() {
        console.log("[MOCK CLIENT]: Closed gRPC connection.");
    }
}

async function getContract() {
    const useMock = process.env.USE_MOCK_LEDGER === 'true';

    if (useMock) {
        console.log("--- ⚡ RUNNING IN MOCK LEDGER MODE (Local JSON Database) ⚡ ---");
        return {
            contract: new MockContract(),
            gateway: new MockGateway(),
            client: new MockClient()
        };
    }

    try {
        // Load fabric dependencies dynamically to prevent crashes if they are not fully functional/installed in mock environment
        const { connect, signers } = require('@hyperledger/fabric-gateway');
        const grpc = require('@grpc/grpc-js');

        // 1. Load the TLS Certificate
        const tlsCertPath = process.env.HLF_TLS_CERT_PATH || '/home/zubby/blockchain-lab/fabric-samples/test-network/organizations/peerOrganizations/org1.example.com/peers/peer0.org1.example.com/tls/ca.crt';
        if (!fs.existsSync(tlsCertPath)) {
            throw new Error(`TLS Cert not found at ${tlsCertPath}`);
        }
        const tlsCert = fs.readFileSync(tlsCertPath);
        const credentials = grpc.credentials.createSsl(tlsCert);

        // 2. Identity material from your existing wallet
        const walletPath = process.env.FABRIC_WALLET_PATH || path.join(__dirname, 'wallet');
        const identityLabel = process.env.FABRIC_IDENTITY || 'zubby';
        const idPath = path.join(walletPath, `${identityLabel}.id`);
        if (!fs.existsSync(idPath)) {
            throw new Error(`Identity file not found at ${idPath}`);
        }
        const idData = JSON.parse(fs.readFileSync(idPath, 'utf8'));
        
        const privateKey = crypto.createPrivateKey(idData.credentials.privateKey);

        // 3. Establish SECURE gRPC connection
        const client = new grpc.Client('127.0.0.1:7051', credentials, {
            'grpc.ssl_target_name_override': 'peer0.org1.example.com'
        });

        // 4. Connect the Gateway
        const gateway = connect({
            client,
            identity: { mspId: idData.mspId, credentials: Buffer.from(idData.credentials.certificate) },
            signer: signers.newPrivateKeySigner(privateKey),
            endorsementByOrg: 'Org1MSP',
            evaluateOptions: () => ({ deadline: Date.now() + 5000 }),
            endorseOptions: () => ({ deadline: Date.now() + 60000 }),
            discovery: false 
        });

        const network = gateway.getNetwork(process.env.HLF_CHANNEL || 'mychannel');
        const contract = network.getContract(process.env.HLF_CHAINCODE || 'basic');

        return { contract, gateway, client };
    } catch (e) {
        console.warn(`--- ⚠️ Fabric Connection Failed: ${e.message}. Falling back to MOCK LEDGER mode. ---`);
        return {
            contract: new MockContract(),
            gateway: new MockGateway(),
            client: new MockClient()
        };
    }
}

module.exports = { getContract };