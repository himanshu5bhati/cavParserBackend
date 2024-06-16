const express = require('express');
const authMiddleware = require('../middleware/authMiddleware');
const { uploadFile, processAndEncryptFile, downloadFile, listFiles } = require('../controllers/fileController');

const router = express.Router();

// POST route for uploading and encrypting files
router.post('/upload', authMiddleware, uploadFile, processAndEncryptFile);

// GET route for downloading and decrypting files
router.get('/download/:id', authMiddleware, downloadFile);

// GET route for files list
router.get('/files', authMiddleware, listFiles);

module.exports = router;
