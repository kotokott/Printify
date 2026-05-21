// Printify Hub Client Application logic

document.addEventListener('DOMContentLoaded', () => {
  // --- State Variables ---
  let printers = [];
  let defaultPrinter = null;
  let activePrinter = null;
  let selectedFile = null;
  let copiesCount = 1;
  let colorMode = 'color';
  let orientation = '3'; // 3 = Portrait, 4 = Landscape
  let pageSize = 'A4';
  let duplexMode = 'None';
  let jobsList = [];
  let pollInterval = null;

  // Paper Sizes dimensions map for mock label
  const paperDimensions = {
    'A4': 'A4 (210×297 мм)',
    'Letter': 'Letter (8.5×11 дюймов)',
    'A3': 'A3 (297×420 мм)',
    'A5': 'A5 (148×210 мм)',
    'Legal': 'Legal (8.5×14 дюймов)',
    'Executive': 'Executive (7.25×10.5 дюймов)',
    'Tabloid': 'Tabloid (11×17 дюймов)'
  };

  // --- DOM Elements ---
  const printerSelect = document.getElementById('printer-select');
  const printerStatusDisplay = document.getElementById('printer-status-display');
  const printerDetail = document.getElementById('printer-detail');
  
  const dropZone = document.getElementById('drop-zone');
  const fileInput = document.getElementById('file-input');
  const previewArea = document.getElementById('preview-area');
  const previewFilename = document.getElementById('preview-filename');
  const previewFilesize = document.getElementById('preview-filesize');
  const btnClearFile = document.getElementById('btn-clear-file');
  const previewVisualBox = document.getElementById('preview-visual-box');
  const previewFileIcon = document.getElementById('preview-file-icon');

  const btnCopiesMinus = document.getElementById('btn-copies-minus');
  const btnCopiesPlus = document.getElementById('btn-copies-plus');
  const inputCopies = document.getElementById('input-copies');

  const btnColorMode = document.getElementById('btn-color-mode');
  const btnGrayMode = document.getElementById('btn-gray-mode');

  const btnOrientPortrait = document.getElementById('btn-orient-portrait');
  const btnOrientLandscape = document.getElementById('btn-orient-landscape');
  const mockSheetElement = document.getElementById('mock-sheet-element');
  const sheetDimensionLabel = document.getElementById('sheet-dimension-label');

  const selectPageSize = document.getElementById('select-pagesize');
  const duplexOptions = document.querySelectorAll('.duplex-option-btn');
  const inputPageRange = document.getElementById('input-pagerange');

  const btnSubmitPrint = document.getElementById('btn-submit-print');
  const btnSubmitContent = btnSubmitPrint.querySelector('.btn-content');
  const btnSubmitSpinner = btnSubmitPrint.querySelector('.spinner-loader');

  const btnRefreshQueue = document.getElementById('btn-refresh-queue');
  const queueTableBody = document.getElementById('queue-table-body');
  const queueCountLabel = document.getElementById('queue-count-label');

  const toastElement = document.getElementById('notification-toast');
  const toastIconBox = document.getElementById('toast-icon-box');
  const toastMessageText = document.getElementById('toast-message-text');

  // --- Toast Notifications ---
  function showToast(message, type = 'success') {
    toastMessageText.textContent = message;
    
    // Clear old state classes
    toastElement.classList.remove('show');
    toastIconBox.className = 'toast-icon';
    
    if (type === 'success') {
      toastIconBox.classList.add('success');
      toastIconBox.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>`;
    } else {
      toastIconBox.classList.add('error');
      toastIconBox.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>`;
    }

    // Force repaint
    void toastElement.offsetWidth;
    
    toastElement.classList.add('show');
    
    setTimeout(() => {
      toastElement.classList.remove('show');
    }, 4000);
  }

  // --- Initializing UI ---
  async function loadPrinters() {
    try {
      const response = await fetch('/api/printers');
      const data = await response.json();
      
      printers = data.printers || [];
      defaultPrinter = data.defaultPrinter;

      printerSelect.innerHTML = '';
      
      if (printers.length === 0) {
        const opt = document.createElement('option');
        opt.value = "";
        opt.textContent = "Принтеры не найдены";
        opt.disabled = true;
        printerSelect.appendChild(opt);
        
        updatePrinterStatusDisplay(null);
        return;
      }

      printers.forEach(printer => {
        const opt = document.createElement('option');
        opt.value = printer.name;
        // Label with uppercase status
        opt.textContent = `${printer.name} (${translatePrinterStatus(printer.status)})`;
        if (printer.name === defaultPrinter) {
          opt.selected = true;
          activePrinter = printer.name;
        }
        printerSelect.appendChild(opt);
      });

      if (!activePrinter && printers.length > 0) {
        activePrinter = printers[0].name;
      }

      const activeObj = printers.find(p => p.name === activePrinter);
      updatePrinterStatusDisplay(activeObj);
      loadPrinterOptions(activePrinter);

    } catch (error) {
      console.error('Error loading printers:', error);
      showToast('Ошибка при загрузке списка принтеров', 'error');
      
      printerSelect.innerHTML = '<option value="" disabled selected>Не удалось связаться с CUPS</option>';
      updatePrinterStatusDisplay(null);
    }
  }

  function translatePrinterStatus(status) {
    switch (status) {
      case 'idle': return 'готов';
      case 'printing': return 'печатает';
      case 'paused': return 'приостановлен';
      default: return 'неизвестно';
    }
  }

  function updatePrinterStatusDisplay(printer) {
    if (!printer) {
      printerStatusDisplay.className = 'printer-status-bar';
      printerStatusDisplay.innerHTML = `
        <span class="printer-badge badge-paused">Ошибки</span>
        <span class="printer-desc">Проверьте службу CUPS или добавьте принтер</span>
      `;
      return;
    }

    printerStatusDisplay.className = 'printer-status-bar';
    
    if (printer.status === 'idle') {
      printerStatusDisplay.innerHTML = `
        <span class="printer-badge badge-idle">Готов</span>
        <span class="printer-desc">Ожидает заданий печати</span>
      `;
    } else if (printer.status === 'printing') {
      printerStatusDisplay.innerHTML = `
        <span class="printer-badge badge-printing">Печать</span>
        <span class="printer-desc">Выполняются активные задачи</span>
      `;
    } else {
      printerStatusDisplay.innerHTML = `
        <span class="printer-badge badge-paused">Остановлен</span>
        <span class="printer-desc">Принтер временно не принимает задачи</span>
      `;
    }
  }

  // Load PPD options dynamically from CUPS for selected printer
  async function loadPrinterOptions(printerName) {
    try {
      const response = await fetch(`/api/printers/${encodeURIComponent(printerName)}/options`);
      const data = await response.json();
      
      const options = data.options || [];
      const pageSizeOpt = options.find(o => o.name === 'PageSize' || o.name === 'MediaSize');
      
      // Update options dropdown with printer-specific sizes if they exist
      if (pageSizeOpt && pageSizeOpt.choices.length > 0) {
        selectPageSize.innerHTML = '';
        pageSizeOpt.choices.forEach(size => {
          const opt = document.createElement('option');
          opt.value = size;
          opt.textContent = size;
          if (size === pageSizeOpt.default || size === 'A4') {
            opt.selected = true;
            pageSize = size;
          }
          selectPageSize.appendChild(opt);
        });
        updateMockSheetLabel();
      }
    } catch (err) {
      console.log('Using standard default page sizes fallback:', err);
    }
  }

  // --- Event Listeners: Printer change ---
  printerSelect.addEventListener('change', (e) => {
    activePrinter = e.target.value;
    const selectedObj = printers.find(p => p.name === activePrinter);
    updatePrinterStatusDisplay(selectedObj);
    loadPrinterOptions(activePrinter);
  });

  // --- Drag & Drop / File Select logic ---
  // Open dialog on dropzone click
  dropZone.addEventListener('click', () => {
    fileInput.click();
  });

  fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      handleFile(e.target.files[0]);
    }
  });

  // Drag states styling
  ['dragenter', 'dragover'].forEach(eventName => {
    dropZone.addEventListener(eventName, (e) => {
      e.preventDefault();
      dropZone.classList.add('dragover');
    }, false);
  });

  ['dragleave', 'drop'].forEach(eventName => {
    dropZone.addEventListener(eventName, (e) => {
      e.preventDefault();
      dropZone.classList.remove('dragover');
    }, false);
  });

  dropZone.addEventListener('drop', (e) => {
    const dt = e.dataTransfer;
    const files = dt.files;
    if (files.length > 0) {
      handleFile(files[0]);
    }
  });

  function handleFile(file) {
    const maxSize = 50 * 1024 * 1024; // 50MB
    if (file.size > maxSize) {
      showToast('Размер файла превышает лимит 50MB', 'error');
      return;
    }

    selectedFile = file;
    previewFilename.textContent = file.name;
    previewFilesize.textContent = (file.size / (1024 * 1024)).toFixed(2) + ' MB';
    
    // File icon type classes
    previewFileIcon.className = 'file-icon-type';
    previewVisualBox.innerHTML = '';

    const ext = file.name.split('.').pop().toLowerCase();
    
    if (ext === 'pdf') {
      previewFileIcon.classList.add('pdf');
      previewFileIcon.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
          <text x="7" y="18" fill="currentColor" font-size="6" font-weight="bold">PDF</text>
        </svg>
      `;
      previewVisualBox.innerHTML = `
        <div class="preview-pdf-mock">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
            <path d="M16 13H8M16 17H8" stroke-width="2"/>
          </svg>
          <span style="font-size: 0.8rem; font-weight: 500;">Файл PDF готов к печати</span>
        </div>
      `;
    } else if (['jpg', 'jpeg', 'png'].includes(ext)) {
      previewFileIcon.classList.add('image');
      previewFileIcon.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
          <circle cx="8.5" cy="8.5" r="1.5"/>
          <polyline points="21 15 16 10 5 21"/>
        </svg>
      `;
      
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = document.createElement('img');
        img.src = e.target.result;
        img.className = 'preview-image';
        previewVisualBox.appendChild(img);
      };
      reader.readAsDataURL(file);
    } else if (['doc', 'docx'].includes(ext)) {
      previewFileIcon.classList.add('word');
      previewFileIcon.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
          <text x="6" y="17" fill="currentColor" font-size="4.5" font-weight="bold">WORD</text>
        </svg>
      `;
      previewVisualBox.innerHTML = `
        <div class="preview-pdf-mock" style="border-color: rgba(43, 87, 154, 0.4);">
          <svg viewBox="0 0 24 24" fill="none" stroke="#2b579a" stroke-width="1.5" style="width: 3.5rem; height: 3.5rem;">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
            <path d="M16 13H8M16 17H8" stroke-width="2"/>
          </svg>
          <span style="font-size: 0.8rem; font-weight: 500; color: #2b579a; margin-top: 0.5rem;">Документ Word готов к печати</span>
        </div>
      `;
    } else if (ext === 'txt') {
      previewFileIcon.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
          <line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>
        </svg>
      `;
      
      const reader = new FileReader();
      reader.onload = (e) => {
        const pre = document.createElement('pre');
        pre.className = 'preview-text';
        pre.textContent = e.target.result;
        previewVisualBox.appendChild(pre);
      };
      reader.readAsText(file);
    } else {
      // Default fallback preview
      previewFileIcon.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
        </svg>
      `;
      previewVisualBox.innerHTML = `<span style="font-size:0.8rem; color:var(--text-secondary);">Предпросмотр недоступен для файла этого формата</span>`;
    }

    dropZone.style.display = 'none';
    previewArea.style.display = 'flex';
    validateForm();
  }

  // Clear Selected File
  btnClearFile.addEventListener('click', (e) => {
    e.stopPropagation();
    clearSelectedFile();
  });

  function clearSelectedFile() {
    selectedFile = null;
    fileInput.value = '';
    previewArea.style.display = 'none';
    dropZone.style.display = 'block';
    previewVisualBox.innerHTML = '';
    validateForm();
  }

  // --- Print Settings Handlers ---
  
  // 1. Copies Count
  btnCopiesPlus.addEventListener('click', () => {
    copiesCount = Math.min(99, copiesCount + 1);
    inputCopies.value = copiesCount;
    btnCopiesMinus.disabled = false;
  });

  btnCopiesMinus.addEventListener('click', () => {
    copiesCount = Math.max(1, copiesCount - 1);
    inputCopies.value = copiesCount;
    if (copiesCount === 1) {
      btnCopiesMinus.disabled = true;
    }
  });

  // 2. Color mode
  btnColorMode.addEventListener('click', () => {
    colorMode = 'color';
    btnColorMode.classList.add('active');
    btnGrayMode.classList.remove('active');
  });

  btnGrayMode.addEventListener('click', () => {
    colorMode = 'gray';
    btnGrayMode.classList.add('active');
    btnColorMode.classList.remove('active');
  });

  // 3. Orientation
  btnOrientPortrait.addEventListener('click', () => {
    orientation = '3';
    btnOrientPortrait.classList.add('active');
    btnOrientLandscape.classList.remove('active');
    
    mockSheetElement.classList.add('portrait');
    mockSheetElement.classList.remove('landscape');
  });

  btnOrientLandscape.addEventListener('click', () => {
    orientation = '4';
    btnOrientLandscape.classList.add('active');
    btnOrientPortrait.classList.remove('active');
    
    mockSheetElement.classList.add('landscape');
    mockSheetElement.classList.remove('portrait');
  });

  // 4. Paper Size Selection
  selectPageSize.addEventListener('change', (e) => {
    pageSize = e.target.value;
    updateMockSheetLabel();
  });

  function updateMockSheetLabel() {
    const text = paperDimensions[pageSize] || pageSize;
    sheetDimensionLabel.textContent = text;
  }

  // 5. Duplex Mode (Double sided)
  duplexOptions.forEach(btn => {
    btn.addEventListener('click', () => {
      // Remove active from siblings
      duplexOptions.forEach(opt => opt.classList.remove('active'));
      
      // Set active
      btn.classList.add('active');
      duplexMode = btn.dataset.value;
    });
  });

  // Form submit validation
  function validateForm() {
    const hasPrinter = !!activePrinter;
    const hasFile = !!selectedFile;
    btnSubmitPrint.disabled = !(hasPrinter && hasFile);
  }

  // --- Print Submission API ---
  btnSubmitPrint.addEventListener('click', async () => {
    if (!activePrinter || !selectedFile) return;

    // Set UI to loading state
    btnSubmitPrint.disabled = true;
    btnSubmitContent.style.visibility = 'hidden';
    btnSubmitSpinner.style.display = 'block';

    const formData = new FormData();
    formData.append('file', selectedFile);
    formData.append('printer', activePrinter);
    formData.append('copies', copiesCount);
    formData.append('pagesize', pageSize);
    formData.append('duplex', duplexMode);
    formData.append('orientation', orientation);
    formData.append('pagerange', inputPageRange.value);
    formData.append('colormode', colorMode);

    try {
      const response = await fetch('/api/print', {
        method: 'POST',
        body: formData
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Ошибка при отправке на печать');
      }

      // Success!
      showToast('Задание успешно отправлено на принтер!');
      
      // Trigger satisfying print physical sheet pop-out animation
      triggerPrintAnimation();

      // Reset state for file
      clearSelectedFile();
      
      // Refresh list
      loadJobsQueue();

    } catch (error) {
      console.error('Error submitting print:', error);
      showToast(error.message, 'error');
    } finally {
      // Reset button states
      btnSubmitPrint.disabled = false;
      btnSubmitContent.style.visibility = 'visible';
      btnSubmitSpinner.style.display = 'none';
      validateForm();
    }
  });

  function triggerPrintAnimation() {
    const printCard = document.querySelector('.settings-card');
    const pageMock = document.createElement('div');
    pageMock.className = 'paper-feed-animation';
    printCard.appendChild(pageMock);
    
    // Remove element after animation completes
    setTimeout(() => {
      pageMock.remove();
    }, 2000);
  }

  // --- Jobs Queue Monitoring logic ---
  async function loadJobsQueue() {
    try {
      const response = await fetch('/api/jobs');
      jobsList = await response.json();
      
      renderJobsTable(jobsList);
      
      // Update count badge
      const activeJobs = jobsList.filter(j => j.status === 'pending' || j.status === 'printing').length;
      queueCountLabel.textContent = `Активных заданий: ${activeJobs}`;

    } catch (error) {
      console.error('Error updating queue:', error);
      queueCountLabel.textContent = 'Ошибка обновления статусов';
    }
  }

  function renderJobsTable(jobs) {
    if (jobs.length === 0) {
      queueTableBody.innerHTML = `
        <tr>
          <td colspan="8" class="empty-table-state">
            <div class="empty-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            </div>
            <p>Очередь печати пуста. Отправьте файл, чтобы увидеть его здесь.</p>
          </td>
        </tr>
      `;
      return;
    }

    queueTableBody.innerHTML = '';
    
    jobs.forEach(job => {
      const tr = document.createElement('tr');
      
      // Format options into tags
      const optTags = [];
      if (job.options.copies > 1) optTags.push(`${job.options.copies} коп.`);
      optTags.push(job.options.pagesize);
      optTags.push(job.options.colormode === 'color' ? 'Цветной' : 'Ч/Б');
      optTags.push(job.options.orientation === 'landscape' ? 'Альбом' : 'Портрет');
      if (job.options.duplex !== 'None') {
        const duplexLabel = job.options.duplex === 'DuplexNoTumble' ? '2-стор(книж)' : '2-стор(альб)';
        optTags.push(duplexLabel);
      }

      const tagsHTML = optTags.map(tag => `<span class="tag">${tag}</span>`).join('');
      
      // Format date
      const dateObj = new Date(job.date);
      const timeStr = dateObj.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) + 
                      ' ' + dateObj.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });

      // Action cancel button status
      const isCancellable = job.status === 'pending' || job.status === 'printing';
      const actionBtn = isCancellable 
        ? `<button class="btn-cancel-job" data-id="${job.id}">
             <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
             Отмена
           </button>`
        : `<span class="text-muted">—</span>`;

      tr.innerHTML = `
        <td style="font-family: monospace; font-weight: 500;">${job.id}</td>
        <td><span style="font-weight: 500;">${job.printer}</span></td>
        <td><span class="file-name" style="max-width: 180px; display: inline-block;" title="${job.filename}">${job.filename}</span></td>
        <td class="text-secondary">${job.size}</td>
        <td><div class="job-options-tags">${tagsHTML}</div></td>
        <td class="text-secondary">${timeStr}</td>
        <td>
          <span class="status-badge ${job.status}">
            <span class="badge-dot"></span>
            ${translateJobStatus(job.status)}
          </span>
        </td>
        <td>${actionBtn}</td>
      `;

      // Set listener for cancel button
      const cancelBtnElement = tr.querySelector('.btn-cancel-job');
      if (cancelBtnElement) {
        cancelBtnElement.addEventListener('click', async (e) => {
          const jobId = e.currentTarget.dataset.id;
          await cancelPrintJob(jobId);
        });
      }

      queueTableBody.appendChild(tr);
    });
  }

  function translateJobStatus(status) {
    switch (status) {
      case 'pending': return 'В очереди';
      case 'printing': return 'Печатается';
      case 'completed': return 'Завершено';
      case 'cancelled': return 'Отменено';
      default: return 'Неизвестно';
    }
  }

  // Cancel Job API
  async function cancelPrintJob(jobId) {
    try {
      const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, {
        method: 'POST'
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Не удалось отменить задание');
      }

      showToast(`Задание ${jobId} отменено`, 'success');
      loadJobsQueue();

    } catch (error) {
      console.error('Error cancelling job:', error);
      showToast(error.message, 'error');
    }
  }

  // --- Manual Refresh Button ---
  btnRefreshQueue.addEventListener('click', () => {
    btnRefreshQueue.disabled = true;
    // Rotate icon briefly
    const svg = btnRefreshQueue.querySelector('svg');
    svg.style.transition = 'transform 0.5s ease';
    svg.style.transform = 'rotate(360deg)';
    
    loadJobsQueue().then(() => {
      setTimeout(() => {
        svg.style.transition = 'none';
        svg.style.transform = 'rotate(0deg)';
        btnRefreshQueue.disabled = false;
      }, 500);
    });
  });

  // --- Initialization & Polling ---
  loadPrinters();
  loadJobsQueue();
  validateForm();

  // Poll job status every 3.5 seconds
  pollInterval = setInterval(loadJobsQueue, 3500);

  // Clean up interval on leave
  window.addEventListener('beforeunload', () => {
    if (pollInterval) clearInterval(pollInterval);
  });
});
