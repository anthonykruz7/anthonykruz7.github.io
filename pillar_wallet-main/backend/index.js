require('dotenv').config();
const express = require('express');
const multer = require('multer');
const upload = multer();
const ipfs = require('./ipfs');
const { getContract } = require('./fabric');
const eccrypto = require('eccrypto-js');
const { createSign, createHash, createPrivateKey, createPublicKey } = require('crypto');
const fs = require('fs');

const app = express();
const cors = require('cors');
const path = require('path');

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.options('*', cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));
app.use('/backend', express.static(__dirname));

// In-memory mock ledger store
const mockLedger = {};

// Endpoint to retrieve locally stored mock IPFS files
app.get('/ipfs/:cid', (req, res) => {
    const { cid } = req.params;
    const filePath = path.join(__dirname, 'mock_ipfs', `${cid}.json`);
    console.log(`[MOCK IPFS]: Fetching local file for CID: ${cid}`);
    if (fs.existsSync(filePath)) {
        try {
            const data = fs.readFileSync(filePath, 'utf8');
            res.json(JSON.parse(data));
        } catch (err) {
            console.error("Failed to read mock IPFS file:", err);
            res.status(500).json({ error: "Failed to read local IPFS payload" });
        }
    } else {
        res.status(404).json({ error: "CID not found in local IPFS store" });
    }
});

let issuerPublicKeyRaw = '';
try {
    const key = createPublicKey({
        key: Buffer.from(process.env.UNI_PUBLIC_KEY || '', 'hex'),
        format: 'der',
        type: 'spki'
    });
    const jwk = key.export({ format: 'jwk' });
    const x = Buffer.from(jwk.x, 'base64');
    const y = Buffer.from(jwk.y, 'base64');
    issuerPublicKeyRaw = Buffer.concat([Buffer.from([0x04]), x, y]).toString('hex');
    console.log("Issuer Public Key Loaded:", issuerPublicKeyRaw);
} catch (e) {
    console.warn("Could not load Issuer Public Key:", e.message);
}

/**
 * Signs the document hash using the University's private key.
 */
async function signHash(hashBuffer, privateKeyHex) {
    const privateKey = Buffer.from(privateKeyHex, 'hex');
    return eccrypto.sign(privateKey, hashBuffer);
}

/**
 * ISSUANCE ENDPOINT
 */
app.post('/issue', upload.single('pdf'), async (req, res) => {
    let gateway, client;
    try {
        const { credentialID, studentPubKey, issuerPrivateKey, issuerName } = req.body;

        if (!req.file) throw new Error("PDF file missing.");
        if (!issuerPrivateKey) throw new Error("Issuer Private Key required for signing.");
        if (!issuerName) throw new Error("Issuer Name required.");

        const rawPdfBuffer = req.file.buffer;

        // 1. Digital Signature Logic
        const pdfHashBuffer = createHash('sha256').update(rawPdfBuffer).digest();
        const pdfHash = pdfHashBuffer.toString('hex');

        // Sign using the PROVIDED University Key
        const signatureBuffer = await signHash(pdfHashBuffer, issuerPrivateKey);
        const issuerSignature = signatureBuffer.toString('hex');

        // 2. Data Transformation
        const pdfBase64 = rawPdfBuffer.toString('base64');

        // 3. Encrypt using the student's Public Key
        const pubKeyBuf = Buffer.from(studentPubKey, 'hex');
        const encrypted = await eccrypto.encrypt(pubKeyBuf, Buffer.from(pdfBase64));

        // 4. Map the ECIES components to clean hex strings
        const encryptedPayload = {
            iv: encrypted.iv.toString('hex'),
            epk: encrypted.ephemPublicKey.toString('hex'),
            ct: encrypted.ciphertext.toString('hex'),
            mac: encrypted.mac.toString('hex')
        };

        // 5. Upload to IPFS
        console.log(`[SYSTEM REFORM]: Pinning encrypted Base64 payload for ${credentialID}`);
        const ipfsCid = await ipfs.uploadBuffer(encryptedPayload, `${credentialID}.json`);

        // 6. Blockchain Commitment
        if (process.env.USE_MOCK_LEDGER !== 'true') {
            const connection = await getContract();
            gateway = connection.gateway;
            client = connection.client;
            await connection.contract.submit('IssueCredential', {
                arguments: [credentialID, studentPubKey, pdfHash, issuerSignature, ipfsCid, issuerName]
            });
        } else {
            console.log(`[MOCK LEDGER]: Storing credential ${credentialID} in memory`);
            mockLedger[`cred_${credentialID}`] = {
                credentialID,
                studentPubKey,
                pdfHash,
                issuerSignature,
                ipfsCID: ipfsCid,
                issuerName
            };
            mockLedger[`uni_${issuerName}`] = { publicKey: eccrypto.getPublic(Buffer.from(issuerPrivateKey, 'hex')).toString('hex') };
        }

        res.json({
            success: true,
            credentialID,
            ipfsCid,
            status: "Credential Aligned & Issued"
        });

    } catch (err) {
        console.error('CRITICAL ISSUANCE FAILURE:', err);
        res.status(500).json({ error: String(err) });
    } finally {
        if (gateway) gateway.close();
        if (client) client.close();
    }
});

/**
 * REGISTRATION ENDPOINT
 */
app.post('/register', async (req, res) => {
    let gateway, client;
    try {
        const { name, authCode } = req.body;
        if (!name) throw new Error("University Name required");
        if (authCode !== "PILLAR-SECURE-2026") throw new Error("Invalid Authorization Code. Payment required.");

        console.log(`[REGISTRY]: Registering new university: ${name}`);

        // Generate Key Pair
        const privateKey = eccrypto.generatePrivate();
        const publicKey = eccrypto.getPublic(privateKey);
        const pubKeyHex = publicKey.toString('hex');
        const privKeyHex = privateKey.toString('hex');

        // Skip blockchain if mock mode
        if (process.env.USE_MOCK_LEDGER !== 'true') {
            const connection = await getContract();
            gateway = connection.gateway;
            client = connection.client;
            await connection.contract.submit('RegisterUniversity', {
                arguments: [name, pubKeyHex]
            });
        } else {
            console.log(`[MOCK LEDGER]: Skipping blockchain for registration of ${name}`);
            mockLedger[`uni_${name}`] = { publicKey: pubKeyHex };
        }

        res.json({
            success: true,
            universityName: name,
            publicKey: pubKeyHex,
            privateKey: privKeyHex,
            message: "University Registered. SAVE PRIVATE KEY SECURELY!"
        });

    } catch (err) {
        console.error("REGISTRATION ERROR:", err);
        const errorMsg = (err.details && err.details.length > 0) ? err.details[0].message : err.message;
        res.status(500).json({ error: errorMsg });
    } finally {
        if (gateway) gateway.close();
        if (client) client.close();
    }
});

/**
 * VERIFY ENDPOINT
 */
app.post('/verify', async (req, res) => {
    let gateway, client;
    try {
        const { credentialID } = req.body;

        if (process.env.USE_MOCK_LEDGER !== 'true') {
            const connection = await getContract();
            gateway = connection.gateway;
            client = connection.client;

            const resultBytes = await connection.contract.evaluate('QueryCredential', {
                arguments: [credentialID]
            });
            const record = JSON.parse(new TextDecoder().decode(resultBytes));

            const uniBytes = await connection.contract.evaluate('QueryUniversity', {
                arguments: [record.issuerName]
            });
            const uniRecord = JSON.parse(new TextDecoder().decode(uniBytes));

            res.json({ success: true, record, issuerPublicKey: uniRecord.publicKey });
        } else {
            console.log(`[MOCK LEDGER]: Querying credential ${credentialID} from memory`);
            const record = mockLedger[`cred_${credentialID}`];
            if (!record) throw new Error(`Credential ${credentialID} not found in mock ledger`);

            const uniRecord = mockLedger[`uni_${record.issuerName}`];
            if (!uniRecord) throw new Error(`University ${record.issuerName} not found in mock ledger`);

            res.json({ success: true, record, issuerPublicKey: uniRecord.publicKey });
        }

    } catch (err) {
        console.error('QUERY FAILURE:', err);
        res.status(500).json({ error: err.message || "Blockchain query failed" });
    } finally {
        if (gateway) gateway.close();
        if (client) client.close();
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`--- 🚀 NUCLEAR ALIGNMENT API: ACTIVE ON PORT ${PORT} 🚀 ---`);
});