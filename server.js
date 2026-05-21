const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS and body parsing
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static frontend files
app.use(express.static(path.join(__dirname, 'public')));

// Configure Multer for file uploads
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    // Preserve original extension but prepend timestamp to prevent collisions
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});
const upload = multer({ storage: storage });

// Local In-Memory Jobs database to track print history
let jobsDb = [];

// Helper function to run commands safely
function runCmd(command) {
  return new Promise((resolve) => {
    exec(command, (error, stdout, stderr) => {
      resolve({
        code: error ? (error.code || 1) : 0,
        stdout: stdout || '',
        stderr: stderr || '',
        error: error || null
      });
    });
  });
}

// 1. GET /api/printers - List all printers and the default printer
app.get('/api/printers', async (req, res) => {
  try {
    const lpstatP = await runCmd('lpstat -p');
    const lpstatD = await runCmd('lpstat -d');

    const printers = [];
    const lines = lpstatP.stdout.split('\n');
    
    for (let line of lines) {
      line = line.trim();
      if (!line) continue;
      
      // Match "printer TestPrinter is idle." or "printer TestPrinter disabled since..."
      const parts = line.split(/\s+/);
      if (parts[0] === 'printer' && parts[1]) {
        const name = parts[1];
        let status = 'unknown';
        if (line.includes('is idle')) {
          status = 'idle';
        } else if (line.includes('is printing')) {
          status = 'printing';
        } else if (line.includes('disabled') || line.includes('paused') || line.includes('stopped')) {
          status = 'paused';
        }
        printers.push({ name, status });
      }
    }

    // Default printer check
    // "system default destination: TestPrinter" or "no system default destination"
    let defaultPrinter = null;
    const dMatch = lpstatD.stdout.match(/system default destination:\s*(\S+)/);
    if (dMatch && dMatch[1]) {
      defaultPrinter = dMatch[1];
    } else if (printers.length > 0) {
      // Fallback to first printer as default if none is configured in CUPS
      defaultPrinter = printers[0].name;
    }

    res.json({ printers, defaultPrinter });
  } catch (error) {
    console.error('Error fetching printers:', error);
    res.status(500).json({ error: 'Failed to fetch printers list' });
  }
});

// 2. GET /api/printers/:name/options - Get supported printer settings (PPD)
app.get('/api/printers/:name/options', async (req, res) => {
  const printerName = req.params.name;
  
  try {
    const result = await runCmd(`lpoptions -p "${printerName}" -l`);
    const options = [];

    if (result.code === 0 && result.stdout.trim()) {
      const lines = result.stdout.split('\n');
      for (let line of lines) {
        line = line.trim();
        if (!line || !line.includes(':')) continue;
        
        const colonIdx = line.indexOf(':');
        const keyPart = line.substring(0, colonIdx).trim();
        const valuesPart = line.substring(colonIdx + 1).trim();
        
        const keyParts = keyPart.split('/');
        const name = keyParts[0];
        const label = keyParts[1] || name;
        
        const choices = [];
        let defaultValue = null;
        const valTokens = valuesPart.split(/\s+/);
        
        for (let token of valTokens) {
          if (!token) continue;
          if (token.startsWith('*')) {
            const val = token.substring(1);
            defaultValue = val;
            choices.push(val);
          } else {
            choices.push(token);
          }
        }
        
        options.push({ name, label, default: defaultValue, choices });
      }
    }

    // Return options. If empty (unable to get PPD), the frontend will handle fallback default options
    res.json({ printer: printerName, options });
  } catch (error) {
    console.error(`Error getting options for printer ${printerName}:`, error);
    res.status(500).json({ error: `Failed to get printer options` });
  }
});

// Helper to query current active jobs and completed jobs from CUPS
async function getCupsJobs() {
  const activeRes = await runCmd('lpstat -o');
  const completedRes = await runCmd('lpstat -W completed -o');
  
  const parseJobs = (stdout) => {
    const jobs = {};
    const lines = stdout.split('\n');
    for (let line of lines) {
      line = line.trim();
      if (!line) continue;
      // Format: "TestPrinter-22 sleepy 1024 Thu May 21..."
      const parts = line.split(/\s+/);
      if (parts[0]) {
        jobs[parts[0]] = {
          user: parts[1] || 'unknown',
          size: parts[2] || 'unknown',
          timeString: parts.slice(3).join(' ')
        };
      }
    }
    return jobs;
  };

  return {
    active: parseJobs(activeRes.stdout),
    completed: parseJobs(completedRes.stdout)
  };
}

// 3. GET /api/jobs - Get status and print logs (merging CUPS data and local database)
app.get('/api/jobs', async (req, res) => {
  try {
    const cups = await getCupsJobs();
    
    // Sync local DB with CUPS info
    jobsDb = jobsDb.map(job => {
      // If it's in the active list, it's still printing or pending
      if (cups.active[job.id]) {
        // Simple heuristic: if we just printed it, it might show active.
        // If it takes longer, it stays active.
        return { ...job, status: 'printing' };
      }
      // If it is in the completed list, it completed successfully
      if (cups.completed[job.id]) {
        return { ...job, status: 'completed' };
      }
      
      // If it's not active nor completed, but was previously printing/pending:
      if (job.status === 'pending' || job.status === 'printing') {
        // CUPS might have finished it quickly and cleared it, or it was cancelled
        // If it was cancelled via API, it would already be marked as cancelled.
        // Let's assume it completed if it vanished from active and we didn't cancel it,
        // or check if 15 seconds have passed.
        const elapsed = Date.now() - new Date(job.date).getTime();
        if (elapsed > 10000) {
          return { ...job, status: 'completed' };
        }
      }
      return job;
    });

    // Return the latest list (sorted by date descending)
    const sortedJobs = [...jobsDb].sort((a, b) => new Date(b.date) - new Date(a.date));
    res.json(sortedJobs);
  } catch (error) {
    console.error('Error fetching jobs:', error);
    res.status(500).json({ error: 'Failed to fetch jobs list' });
  }
});

// 4. POST /api/print - Print file with configurations
app.post('/api/print', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const {
    printer,
    copies = 1,
    pagesize,
    duplex,
    orientation,
    pagerange,
    colormode
  } = req.body;

  if (!printer) {
    // Clean up uploaded file before returning error
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: 'Printer name is required' });
  }

  const filePath = req.file.path;
  const originalName = req.file.originalname;
  const fileSizeStr = (req.file.size / 1024).toFixed(1) + ' KB';

  // Build the lp command arguments
  const args = [`-d "${printer}"`, `-n ${copies}`];

  // Page Size (media)
  if (pagesize) {
    args.push(`-o media=${pagesize}`);
  }

  // Duplex
  if (duplex && duplex !== 'None') {
    // Map standard Duplex options or pass them directly
    if (duplex === 'DuplexNoTumble' || duplex === 'two-sided-long-edge') {
      args.push('-o sides=two-sided-long-edge');
    } else if (duplex === 'DuplexTumble' || duplex === 'two-sided-short-edge') {
      args.push('-o sides=two-sided-short-edge');
    } else {
      args.push(`-o sides=${duplex}`);
    }
  } else {
    args.push('-o sides=one-sided');
  }

  // Page Orientation
  // CUPS standard: 3 = portrait, 4 = landscape, 5 = reverse landscape, 6 = reverse portrait
  if (orientation) {
    args.push(`-o orientation-requested=${orientation}`);
  }

  // Page range
  if (pagerange && pagerange.trim() && pagerange.trim().toLowerCase() !== 'all') {
    // Validate range format (e.g., 1-3,5)
    const sanitizedRange = pagerange.replace(/\s+/g, '');
    if (/^[0-9,-]+$/.test(sanitizedRange)) {
      args.push(`-o page-ranges=${sanitizedRange}`);
    }
  }

  // Color mode
  if (colormode) {
    if (colormode.toLowerCase() === 'gray' || colormode.toLowerCase() === 'monochrome' || colormode.toLowerCase() === 'bw') {
      // Add typical monochrome switches for maximum printer compatibility
      args.push('-o ColorModel=Gray');
      args.push('-o ColorMode=Monochrome');
      args.push('-o output-mode=monochrome');
    } else {
      args.push('-o ColorModel=Color');
      args.push('-o ColorMode=Color');
      args.push('-o output-mode=color');
    }
  }

  const fullCommand = `lp ${args.join(' ')} "${filePath}"`;
  console.log(`Executing print command: ${fullCommand}`);

  try {
    const result = await runCmd(fullCommand);
    
    // Clean up uploaded file from temp storage after sending to lp
    // (lp makes a copy or reads it into CUPS queue immediately)
    setTimeout(() => {
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      } catch (err) {
        console.error('Error deleting temp upload file:', err);
      }
    }, 1000);

    if (result.code !== 0) {
      console.error(`CUPS lp error:`, result.stderr);
      return res.status(500).json({ error: `Print command failed: ${result.stderr || 'Unknown error'}` });
    }

    // Parse job ID from stdout: "request id is TestPrinter-22 (1 file(s))"
    const match = result.stdout.match(/request id is (\S+)/);
    const jobId = match ? match[1] : `job-${Date.now()}`;

    const newJob = {
      id: jobId,
      printer: printer,
      filename: originalName,
      size: fileSizeStr,
      date: new Date().toISOString(),
      status: 'pending',
      options: {
        copies: parseInt(copies, 10),
        pagesize: pagesize || 'default',
        duplex: duplex || 'one-sided',
        orientation: orientation === '4' ? 'landscape' : 'portrait',
        colormode: colormode || 'color'
      }
    };

    jobsDb.push(newJob);
    
    res.json({
      success: true,
      message: `Job submitted successfully`,
      job: newJob
    });
  } catch (error) {
    console.error('Print handler error:', error);
    // Clean up file if still exists
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    res.status(500).json({ error: 'Failed to process print job' });
  }
});

// 5. POST /api/jobs/:id/cancel - Cancel a job
app.post('/api/jobs/:id/cancel', async (req, res) => {
  const jobId = req.params.id;
  
  try {
    console.log(`Cancelling job: ${jobId}`);
    const result = await runCmd(`cancel "${jobId}"`);
    
    // Find job in local DB and update its status
    const jobIndex = jobsDb.findIndex(j => j.id === jobId);
    if (jobIndex !== -1) {
      jobsDb[jobIndex].status = 'cancelled';
    }

    if (result.code !== 0) {
      // Even if CUPS cancel returns non-zero (e.g. job already finished), 
      // we still return success if we updated local DB or inform the user
      return res.json({
        success: true,
        message: `Job updated to cancelled locally. CUPS output: ${result.stderr.trim() || 'Done'}`
      });
    }

    res.json({ success: true, message: `Job ${jobId} cancelled successfully` });
  } catch (error) {
    console.error(`Error cancelling job ${jobId}:`, error);
    res.status(500).json({ error: 'Failed to cancel job' });
  }
});

// Start Server
app.listen(PORT, () => {
  console.log(`==================================================`);
  console.log(`Printify local printing server is running!`);
  console.log(`URL: http://localhost:${PORT}`);
  console.log(`==================================================`);
});
