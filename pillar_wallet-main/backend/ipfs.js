require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Uploads an encrypted JSON object to IPFS via Pinata, or saves it locally in mock mode.
 * @param {Object} dataObject - The ECIES encrypted data as a hex-string object.
 * @param {string} fileName - Metadata name.
 * @returns {Promise<string>} - IPFS Hash (CID).
 */
async function uploadBuffer(dataObject, fileName = 'credential.json') {
  const useMock = process.env.USE_MOCK_IPFS === 'true' || !process.env.PINATA_API_KEY || !process.env.PINATA_SECRET;

  if (useMock) {
    console.log("--- ⚡ RUNNING IN MOCK IPFS MODE (Local Storage) ⚡ ---");
    // Generate a mock CID based on hash of payload
    const payloadStr = JSON.stringify(dataObject);
    const hash = crypto.createHash('sha256').update(payloadStr).digest('hex');
    const mockCid = 'QmLocalMockIPFS' + hash.slice(0, 30);

    const dirPath = path.join(__dirname, 'mock_ipfs');
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }

    const filePath = path.join(dirPath, `${mockCid}.json`);
    fs.writeFileSync(filePath, payloadStr, 'utf8');
    console.log(`[MOCK IPFS]: Saved encrypted JSON file to local IPFS path: ${filePath}`);
    console.log(`[MOCK IPFS]: Returning Mock CID: ${mockCid}`);
    return mockCid;
  }

  const PINATA_API_KEY = process.env.PINATA_API_KEY;
  const PINATA_SECRET = process.env.PINATA_SECRET;

  // Use the pinJSONToIPFS endpoint to keep the object structure
  const url = 'https://api.pinata.cloud/pinning/pinJSONToIPFS';

  const body = {
    pinataContent: dataObject,
    pinataMetadata: { name: fileName }
  };

  try {
    const resp = await axios.post(url, body, {
      headers: {
        'Content-Type': 'application/json',
        'pinata_api_key': PINATA_API_KEY,
        'pinata_secret_api_key': PINATA_SECRET,
      }
    });

    if (resp.data && resp.data.IpfsHash) {
      console.log(`#### IPFS UPLOAD SUCCESS: ${resp.data.IpfsHash} ####`);
      return resp.data.IpfsHash;
    }
    throw new Error("No CID returned from Pinata");
  } catch (error) {
    const errorMsg = error.response ? JSON.stringify(error.response.data) : error.message;
    throw new Error('PINATA STORAGE ERROR: ' + errorMsg);
  }
}

module.exports = { uploadBuffer };