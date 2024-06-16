const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const cron = require('node-cron');
const File = require('../models/File');
const User = require('../models/User');

// Set up nodemailer
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'uploads/');
  },
  filename: function (req, file, cb) {
    cb(null, file.originalname);
  },
});

const upload = multer({ 
  storage,
  fileFilter: function (req, file, cb) {
    // Example: Allow only CSV files
    if (file.mimetype !== 'text/csv') {
      return cb(new Error('Only CSV files are allowed'));
    }
    cb(null, true);
  }
});

exports.uploadFile = upload.single('file');

exports.processAndEncryptFile = async (req, res) => {
  const { filename, path: filePath } = req.file;
  const userId = req.userId;

  try {
    // Read the CSV file content
    const csvData = fs.readFileSync(filePath, 'utf8');

    // Sort the CSV data
    const sortedCsvData = sortCsvData(csvData);

    // Write the sorted data to a temporary file
    const sortedFilePath = path.join('uploads', 'sorted_' + filename);
    fs.writeFileSync(sortedFilePath, sortedCsvData);

    // Encrypt the sorted file
    const { encryptedFilePath, iv, encryptionKey } = await encryptFile(sortedFilePath);

    // Save file metadata to MongoDB
    const newFile = new File({
      filename: filename + '.enc',
      path: encryptedFilePath,
      uploader: userId,
      iv: iv.toString('hex'),
      encryptionKey: encryptionKey.toString('hex'),
      uploadDate: new Date()
    });
    await newFile.save();

    // Delete original and temporary sorted files
    fs.unlinkSync(filePath);
    fs.unlinkSync(sortedFilePath);

    // Return response with file information
    res.json({ filename: filename + '.enc', iv: iv.toString('hex') });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to upload and encrypt file' });
  }
};

// Helper function to sort CSV data
function sortCsvData(csvData) {
  const rows = csvData.trim().split('\n');
  const header = rows.shift();
  const dataRows = rows.map(row => row.split(','));
  dataRows.sort((a, b) => parseFloat(b[1]) - parseFloat(a[1]));
  return [header, ...dataRows.map(row => row.join(','))].join('\n');
}

// Helper function to encrypt file
function encryptFile(filePath) {
  return new Promise((resolve, reject) => {
    const encryptionKey = crypto.randomBytes(32);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', encryptionKey, iv);

    const encryptedFilePath = path.join('uploads', path.basename(filePath) + '.enc');
    const output = fs.createWriteStream(encryptedFilePath);
    const input = fs.createReadStream(filePath);
    
    input.pipe(cipher).pipe(output);
    output.on('finish', () => {
      resolve({ encryptedFilePath, iv, encryptionKey });
    });
    output.on('error', reject);
  });
}

exports.downloadFile = async (req, res) => {
  const fileId = req.params.id;

  try {
    const file = await File.findById(fileId);

    if (!file) {
      return res.status(404).json({ message: 'File not found' });
    }

    const { path: encryptedFilePath, iv, encryptionKey, filename } = file;

    if (!encryptionKey || !iv || encryptionKey.length !== 64 || iv.length !== 32) {
      return res.status(400).json({ message: 'Invalid encryption key or IV' });
    }

    // Read the encrypted file into memory
    const encryptedData = fs.readFileSync(encryptedFilePath);

    // Decrypt the file data
    const decryptedData = decryptFile(encryptedData, encryptionKey, iv);

    // Set headers for file download
    res.setHeader('Content-disposition', 'attachment; filename=' + filename);
    res.setHeader('Content-type', 'text/csv');

    // Send the decrypted data to the client
    res.send(decryptedData);
  } catch (err) {
    console.error('Failed to download file:', err);
    res.status(500).json({ message: 'Failed to download file' });
  }
};

// Helper function to decrypt file
function decryptFile(encryptedData, encryptionKey, iv) {
  const keyBuffer = Buffer.from(encryptionKey, 'hex');
  const ivBuffer = Buffer.from(iv, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', keyBuffer, ivBuffer);
  return Buffer.concat([decipher.update(encryptedData), decipher.final()]);
}

// Schedule a task to delete files older than 30 days
cron.schedule('0 0 * * *', async () => {
  try {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const oldFiles = await File.find({ uploadDate: { $lt: thirtyDaysAgo } });

    for (const file of oldFiles) {
      try {
        fs.unlinkSync(file.path);
        await File.deleteOne({ _id: file._id });

        // Send an email to the uploader
        const user = await User.findById(file.uploader);
        if (user) {
          const mailOptions = {
            from: process.env.EMAIL_USER,
            to: user.email,
            subject: 'File Deleted',
            text: `Your file ${file.filename} has been deleted after 30 days.`
          };

          transporter.sendMail(mailOptions, (error, info) => {
            if (error) {
              console.error(`Failed to send email: ${error}`);
            } else {
              console.log(`Email sent: ${info.response}`);
            }
          });
        }
      } catch (deleteError) {
        console.error(`Failed to delete file ${file.filename}: ${deleteError}`);
      }
    }
  } catch (err) {
    console.error('Failed to delete old files:', err);
  }
});

exports.listFiles = async (req, res) => {
  try {
    const files = await File.find();
    res.json(files);
  } catch (err) {
    console.error('Failed to retrieve files:', err);
    res.status(500).json({ message: 'Failed to retrieve files' });
  }
};
