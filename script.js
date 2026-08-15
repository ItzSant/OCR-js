// --- ELEMENTOS DEL DOM ---
const imageInput = document.getElementById('imageInput');
const cameraInput = document.getElementById('cameraInput');
const btnTomarFoto = document.getElementById('btnTomarFoto');
const originalImage = document.getElementById('originalImage');
const outputCanvas = document.getElementById('outputCanvas');
const btnExtraerTexto = document.getElementById('btnExtraerTexto');
const ocrResult = document.getElementById('ocrResult');
const jsonResult = document.getElementById('jsonResult'); // Nuevo elemento
const progressText = document.getElementById('progressText');
const apiKeyInput = document.getElementById('apiKey');

let ocrEnProceso = false;

// --- MENSAJE DE ERROR EN PANTALLA (reutilizable) ---
function mostrarError(mensaje) {
  progressText.style.color = "#c0392b";
  progressText.innerText = `Error: ${mensaje}`;
}

// --- CARGA DE IMAGEN (compartida entre "Seleccionar Voucher" y "Tomar Foto") ---
function cargarImagenDesdeArchivo(file) {
  if (!file) return;

  if (!file.type.startsWith('image/')) {
    mostrarError('El archivo seleccionado no es una imagen valida.');
    return;
  }

  const reader = new FileReader();

  reader.onerror = () => {
    mostrarError('No se pudo leer el archivo. Intenta nuevamente.');
  };

  reader.onload = (event) => {
    originalImage.onerror = () => {
      mostrarError('No se pudo cargar la imagen. Es posible que el archivo este danado.');
    };

    originalImage.onload = () => {
      originalImage.style.display = 'inline-block';

      outputCanvas.width = originalImage.naturalWidth;
      outputCanvas.height = originalImage.naturalHeight;
      const ctx = outputCanvas.getContext('2d');
      ctx.drawImage(originalImage, 0, 0);

      // Limpiamos resultados de una extraccion anterior al cargar una imagen nueva
      ocrResult.value = '';
      jsonResult.value = '';
      progressText.style.color = '';
      progressText.innerText = '';

      if (!ocrEnProceso) btnExtraerTexto.disabled = false;
    };

    originalImage.src = event.target.result;
  };

  reader.readAsDataURL(file);
}

// --- EVENTOS DE INTERFAZ ---
imageInput.addEventListener('change', (e) => {
  cargarImagenDesdeArchivo(e.target.files[0]);
});

// El boton "Tomar Foto" simplemente abre el input oculto con capture="environment",
// que en la mayoria de celulares abre la camara trasera directamente (no la galeria).
btnTomarFoto.addEventListener('click', () => {
  cameraInput.click();
});

cameraInput.addEventListener('change', (e) => {
  cargarImagenDesdeArchivo(e.target.files[0]);
  // Permite volver a tomar otra foto aunque se seleccione el mismo archivo/posicion
  cameraInput.value = '';
});

// --- FUNCION DE COMPRESION SEGURA (< 5MB) ---
function obtenerBase64Seguro(canvas, maxMegabytes = 4.8) {
  const maxBytes = maxMegabytes * 1024 * 1024;
  let calidad = 0.9;
  let base64 = canvas.toDataURL('image/jpeg', calidad);
  let pesoBytes = Math.round((base64.length * 3) / 4);

  while (pesoBytes > maxBytes && calidad > 0.1) {
    calidad -= 0.1;
    base64 = canvas.toDataURL('image/jpeg', calidad);
    pesoBytes = Math.round((base64.length * 3) / 4);
    console.log(`Comprimiendo calidad a ${calidad.toFixed(1)} - Peso: ${(pesoBytes/1024/1024).toFixed(2)} MB`);
  }

  if (pesoBytes > maxBytes) {
    console.log("Resolucion demasiado alta. Redimensionando canvas a la mitad...");
    const canvasEscalado = document.createElement('canvas');
    const ctxEscalado = canvasEscalado.getContext('2d');
    canvasEscalado.width = canvas.width / 2;
    canvasEscalado.height = canvas.height / 2;
    ctxEscalado.drawImage(canvas, 0, 0, canvasEscalado.width, canvasEscalado.height);
    return obtenerBase64Seguro(canvasEscalado, maxMegabytes);
  }

  console.log(`Base64 final listo. Peso: ${(pesoBytes/1024/1024).toFixed(2)} MB`);
  return base64;
}


// ==========================================
// EXTRACCION DE CAMPOS (portado del proyecto Tesseract)
// ==========================================
// Reemplaza al antiguo parsearVoucher(). Ya no basta con que un patron
// "se parezca" a un dato: cada campo exige una etiqueta reconocible en el
// texto (ej. "CODIGO DE CUENTA", "CCI", "IMPORTE DEPOSITADO") junto con un
// formato valido. Ademas reconstruye montos enmascarados donde el OCR
// confundio asteriscos con letras o con ceros.

function limpiarTexto(fragmento) {
  return fragmento.replace(/\s+/g, " ").trim();
}

function extraerVoucherBcp(texto) {

  const lineas = texto
    .split(/\r?\n/)
    .map(limpiarTexto)
    .filter(Boolean);

  const datos = {
    "Entidad": "",
    "Tipo de operacion": "",
    "Detalle": "",
    "Titular": "",
    "Codigo de cuenta": "",
    "CCI": "",
    "Importe depositado": ""
  };

  const normalizarEtiqueta = linea => linea
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/0/g, "O")
    .replace(/1/g, "I")
    .replace(/5/g, "S")
    .replace(/[^A-Z]/g, "");

  const normalizarTitular = titular => limpiarTexto(titular)
    // El OCR suele anadir comillas, barras o separadores solo en los
    // extremos de una razon social. No se toca ningun caracter interno.
    .replace(/^[\s"'“”‘’`?|\\/]+|[\s"'“”‘’`?|\\/]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  const extraerCciDeLinea = linea => {
    const coincidencias = linea.match(/[0-9OIL][0-9OIL\s-]{19,}/gi) || [];

    for (const coincidencia of coincidencias) {
      const digitos = coincidencia
        .replace(/[\s-]/g, "")
        .replace(/O/gi, "0")
        .replace(/[IL]/gi, "1");

      if (digitos.length >= 20) {
        return digitos.slice(-20);
      }
    }

    return "";
  };

  const esCuenta = linea => {
    const etiqueta = normalizarEtiqueta(linea);
    return (etiqueta.includes("CODIGODECUENTA") || etiqueta.includes("CODIGOCUENTA")) && /[0-9]{4,}/.test(linea);
  };

  const esCci = linea => normalizarEtiqueta(linea).includes("CCI") || Boolean(extraerCciDeLinea(linea));
  const esImporte = linea => {
    const etiqueta = normalizarEtiqueta(linea);
    return (etiqueta.includes("IMPORTE") || etiqueta.includes("ONPORTE")) &&
      (etiqueta.includes("DEPOSITADO") || etiqueta.includes("OEPOSITADO"));
  };

  const indiceCuenta = lineas.findIndex(esCuenta);
  const indiceCci = lineas.findIndex(esCci);
  const indiceImporte = lineas.findIndex(esImporte);
  const indiceEntidad = lineas.findIndex(linea => /B\s*[CGL€]\s*P/i.test(linea));

  // Algunas fotos hacen que la sigla BCP no sea legible. En ese caso, la
  // combinacion de las etiquetas propias de esta plantilla permite
  // continuar sin inventar valores de otro tipo de voucher.
  const pareceBcp = indiceEntidad !== -1 ||
    (indiceCuenta !== -1 && indiceCci !== -1) ||
    (indiceCuenta !== -1 && indiceImporte !== -1);

  if (!pareceBcp) {
    return datos;
  }

  datos["Entidad"] = "BCP";

  const operacion = lineas.slice(indiceEntidad + 1).find(linea =>
    /D[E3]P[O0]S[I1L]T[O0]|TRANSFER|PAG[O0]/i.test(linea)
  );

  if (operacion) {
    datos["Tipo de operacion"] = limpiarTexto(operacion)
      .toUpperCase()
      .replace(/D[E3]P[O0]S[I1L]T[O0]/g, "DEPOSITO")
      .replace(/CU[E3]NTA/g, "CUENTA")
      .replace(/C[O0]RR[I1L]ENTE/g, "CORRIENTE")
      .replace(/\bM[NH]A\b/g, "MNA");
  }

  const detalle = lineas.find(linea =>
    /^(?:O[F4]|0F|U[F4])\.?\s*\/|\b(?:O[P9]|0P)[\s\-./]/i.test(linea) ||
    /\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}/.test(linea)
  );
  if (detalle) {
    datos["Detalle"] = limpiarTexto(detalle)
      .replace(/^(?:0F|OF|UF)\s*\.?/i, "OF.")
      .replace(/\b(?:0P|OP)\s*-/gi, "OP-");
  }

  if (indiceCuenta > 0) {
    const titular = lineas[indiceCuenta - 1];
    if (!esCci(titular) && !esImporte(titular) && titular !== operacion && titular !== detalle) {
      datos["Titular"] = normalizarTitular(titular).toUpperCase();
    }
  }

  if (indiceCuenta !== -1) {
    const valor = lineas[indiceCuenta].match(/\d{3}-\d{5,}-\d-\d{2}/) ||
      lineas[indiceCuenta].match(/[0-9][0-9\s-]{5,}/);
    if (valor) {
      datos["Codigo de cuenta"] = valor[0].replace(/\s+/g, "").trim();
    }
  }

  if (indiceCci !== -1) {
    const cci = extraerCciDeLinea(lineas[indiceCci]);
    if (/^\d{20}$/.test(cci)) {
      datos["CCI"] = cci;
    }
  }

  if (indiceImporte !== -1) {
    const valor = lineas[indiceImporte].match(
      // El grupo de mascara ahora tambien admite espacios/tabs intercalados:
      // el OCR a veces lee el importe como si fueran celdas de tabla
      // separadas (ej. "S/***" + tab + "**16,648.97").
      /(?:S\s*\/|\$\s*\/)\s*[^0-9A-Za-z*]*((?:[0-9A-Za-z*]|\s)*?)\s*(\d{1,3}(?:,\d{3})*\.\d{2}|\d+\.\d{2})/i
    );
    if (valor) {
      // Quitamos espacios/tabs del grupo ANTES de convertir a asteriscos,
      // para no confundir un separador de tabla con un digito enmascarado.
      // Todo caracter no numerico restante entre el simbolo monetario y la
      // cifra visible es una mascara probable (ej. "x****" -> "*****").
      const mascara = valor[1].replace(/\s+/g, "").replace(/[^0-9]/g, "*");
      let importe = (mascara + valor[2]).replace(/\s+/g, "");

      // Ceros inmediatamente antes de una zona enmascarada suelen ser
      // asteriscos leidos como "0". No se eliminan: se convierten a
      // asteriscos y conservan su posicion.
      importe = importe.replace(/0+\*+(?=\d)/g, coincidencia =>
        "*".repeat(coincidencia.length)
      );

      datos["Importe depositado"] = "S/" + importe;
    }
  }

  return datos;
}

// ==========================================
// CAPA DE VALIDACION DE CONFIANZA
// ==========================================
// Cada campo se acepta solo si combina una etiqueta reconocible con un
// formato valido. Las semejanzas solas nunca bastan para aceptar numeros:
// si el puntaje no llega al umbral, el campo se descarta explicitamente
// en vez de mostrar un valor dudoso como si fuera correcto.

function evaluarConfianzaBcp(textoReconocido) {

  const datos = extraerVoucherBcp(textoReconocido);
  const texto = textoReconocido.toUpperCase();
  const puntajes = {
    "Entidad": 0,
    "Tipo de operacion": 0,
    "Detalle": 0,
    "Titular": 0,
    "Codigo de cuenta": 0,
    "CCI": 0,
    "Importe depositado": 0
  };

  if (/\bBCP\b/.test(texto)) {
    puntajes["Entidad"] = 100;
  }
  else if (/\bB\s*[C€E]\s*[PR]\b/.test(texto)) {
    puntajes["Entidad"] = 80;
  }
  else if (datos["Entidad"] === "BCP") {
    puntajes["Entidad"] = 65;
  }

  if (/\bDEPOSITO\s+CUENTA\s+CORRIENTE\s+MNA\b/.test(texto)) {
    puntajes["Tipo de operacion"] = 100;
  }
  else if (/D[E3]P[O0]S[I1L]T[O0]/.test(texto)) {
    puntajes["Tipo de operacion"] = 80;
  }

  const detalle = datos["Detalle"];
  if (detalle) {
    let puntajeDetalle = 0;
    if (/^OF\.?\s*\//i.test(detalle)) puntajeDetalle += 25;
    if (/\d{6}-[A-Z]{3,}-\d{6}/i.test(detalle)) puntajeDetalle += 25;
    if (/OP-\d{7}/i.test(detalle)) puntajeDetalle += 25;
    if (/\d{2}\/\d{2}\/\d{4}/.test(detalle)) puntajeDetalle += 25;
    puntajes["Detalle"] = puntajeDetalle;
  }

  if (datos["Titular"] && /^[A-ZÁÉÍÓÚÑ0-9&.$,()'\-/\s]+$/i.test(datos["Titular"]) && datos["Titular"].length >= 5) {
    puntajes["Titular"] = 80;
  }

  if (/^\d{3}-\d{7}-\d-\d{2}$/.test(datos["Codigo de cuenta"])) {
    puntajes["Codigo de cuenta"] = 100;
  }

  if (/^\d{20}$/.test(datos["CCI"])) {
    puntajes["CCI"] = 100;
  }

  const importe = datos["Importe depositado"];
  if (/^S\/[*\d]+(?:,\d{3})*\.\d{2}$/.test(importe)) {
    puntajes["Importe depositado"] = /IMPORTE\s+DEPOSITADO/.test(texto) ? 100 : 80;
  }

  const umbrales = {
    "Entidad": 80,
    "Tipo de operacion": 80,
    "Detalle": 75,
    "Titular": 75,
    "Codigo de cuenta": 100,
    "CCI": 100,
    "Importe depositado": 80
  };

  const datosValidados = {};
  const camposNoConfiables = [];

  Object.keys(datos).forEach(campo => {
    if (puntajes[campo] >= umbrales[campo]) {
      datosValidados[campo] = datos[campo];
    }
    else {
      // Se conserva el estilo de "No identificado" del proyecto original
      // en vez de dejar el campo vacio, para que la salida sea legible.
      datosValidados[campo] = "No identificado";
      camposNoConfiables.push(campo);
    }
  });

  return {
    datos: datosValidados,
    puntajes: puntajes,
    camposNoConfiables: camposNoConfiables,
    esConfiable: camposNoConfiables.length === 0
  };
}

// --- LOGICA DE EXTRACCION (API OCR.space) ---
btnExtraerTexto.addEventListener('click', async () => {
  if (ocrEnProceso) return;

  const llaveUsada = apiKeyInput.value.trim();
  if (!llaveUsada) {
    alert("Por favor, ingresa una API Key.");
    return;
  }

  if (!outputCanvas.width || !outputCanvas.height) {
    alert("Primero selecciona o toma una foto del voucher.");
    return;
  }

  // Bloquear UI mientras dura el procesamiento
  ocrEnProceso = true;
  btnExtraerTexto.disabled = true;
  imageInput.disabled = true;
  cameraInput.disabled = true;
  btnTomarFoto.disabled = true;
  apiKeyInput.disabled = true;

  const textoBotonOriginal = btnExtraerTexto.innerText;
  btnExtraerTexto.innerText = "Procesando...";

  ocrResult.value = '';
  jsonResult.value = ''; // Limpiar JSON anterior
  progressText.style.color = "#e67e22";
  progressText.innerText = "Optimizando y comprimiendo imagen...";

  // Controlador de tiempo limite: evita que la app quede "colgada"
  // indefinidamente si OCR.space no responde.
  const controlador = new AbortController();
  const tiempoLimite = setTimeout(() => controlador.abort(), 45000);

  try {
    const base64Image = obtenerBase64Seguro(outputCanvas, 4.8);

    const formData = new FormData();
    formData.append('base64Image', base64Image);
    formData.append('language', 'spa');
    formData.append('OCREngine', '2');
    formData.append('isTable', 'true');
    formData.append('apikey', llaveUsada);

    progressText.innerText = "Enviando imagen a OCR.space... Esperando respuesta.";

    // --- 1. Error de red / conexion / tiempo de espera agotado ---
    let response;
    try {
      response = await fetch('https://api.ocr.space/parse/image', {
        method: 'POST',
        body: formData,
        signal: controlador.signal
      });
    } catch (fetchError) {
      if (fetchError.name === 'AbortError') {
        throw new Error("El servicio de OCR tardo demasiado en responder. Verifica tu conexion e intenta nuevamente.");
      }
      throw new Error("No se pudo conectar con el servicio de OCR. Verifica tu conexion a internet.");
    }

    // --- 2. Errores HTTP (llave invalida, limite excedido, servidor caido, etc.) ---
    if (!response.ok) {
      if (response.status === 403) {
        throw new Error("API Key invalida o sin permisos. Verifica la llave ingresada.");
      }
      if (response.status === 429) {
        throw new Error("Se alcanzo el limite de solicitudes permitidas. Espera unos minutos o usa otra llave.");
      }
      if (response.status >= 500) {
        throw new Error(`El servicio de OCR no esta disponible en este momento (HTTP ${response.status}). Intenta nuevamente mas tarde.`);
      }
      throw new Error(`El servicio de OCR respondio con un error (HTTP ${response.status}).`);
    }

    // --- 3. Respuesta que no es JSON valido ---
    let data;
    try {
      data = await response.json();
    } catch (parseError) {
      throw new Error("La respuesta del servicio de OCR no se pudo interpretar. Intenta nuevamente.");
    }

    // --- 4. Error reportado explicitamente por la API ---
    if (data.IsErroredOnProcessing) {
      const mensaje = Array.isArray(data.ErrorMessage)
        ? data.ErrorMessage.join(' ')
        : (data.ErrorMessage || "Error desconocido al procesar la imagen.");
      throw new Error(mensaje);
    }

    // --- 5. Respuesta sin resultados utilizables ---
    if (!data.ParsedResults || data.ParsedResults.length === 0) {
      throw new Error("El servicio de OCR no devolvio resultados. Intenta con una imagen mas clara.");
    }

    const primerResultado = data.ParsedResults[0];

    // FileParseExitCode: 1 = exito. Cualquier otro valor indica un problema
    // al parsear ese archivo especifico (imagen corrupta, formato no soportado, etc.)
    if (primerResultado.FileParseExitCode && primerResultado.FileParseExitCode !== 1) {
      throw new Error(primerResultado.ErrorMessage || "No se pudo procesar la imagen. Intenta con otra foto, mejor iluminada y enfocada.");
    }

    const textoExtraido = primerResultado.ParsedText || '';

    // --- 6. OCR exitoso pero sin texto detectable (foto borrosa, vacia, etc.) ---
    if (!textoExtraido.trim()) {
      progressText.style.color = "#e67e22";
      progressText.innerText = "No se detecto texto en la imagen. Intenta con una foto mas nitida y bien iluminada.";
      ocrResult.value = '';
      jsonResult.value = JSON.stringify({ aviso: "No se detecto texto en la imagen" }, null, 2);
      return;
    }

    // --- MANEJO DE RESULTADOS (caso exitoso) ---
    ocrResult.value = textoExtraido;

    // Extraccion + validacion de confianza (portado del proyecto Tesseract):
    // cada campo solo se acepta si combina una etiqueta reconocible con un
    // formato valido; si no, se marca como "No identificado" explicitamente.
    const evaluacion = evaluarConfianzaBcp(textoExtraido);
    jsonResult.value = JSON.stringify(evaluacion.datos, null, 2);

    if (evaluacion.esConfiable) {
      progressText.style.color = "#27ae60";
      progressText.innerText = "Texto extraido y estructurado con exito!";
    } else {
      progressText.style.color = "#e67e22";
      progressText.innerText =
        "Texto extraido, pero no se pudo validar con suficiente confianza: " +
        evaluacion.camposNoConfiables.join(", ") +
        ". Verifica esos campos o vuelve a tomar la foto con mejor iluminacion y encuadre.";
    }

  } catch (error) {
    console.error("Error OCR:", error);

    let mensajeFinal = error.message || "Ocurrio un error inesperado al procesar la imagen.";
    if (/free api limit/i.test(mensajeFinal)) {
      mensajeFinal = "Limite de la llave gratuita 'helloworld' alcanzado. Consigue tu llave privada gratuita en ocr.space.";
    }

    progressText.style.color = "#c0392b";
    progressText.innerText = `Error: ${mensajeFinal}`;
    jsonResult.value = JSON.stringify({ resultado: "error", mensaje: mensajeFinal }, null, 2);

  } finally {
    clearTimeout(tiempoLimite);
    ocrEnProceso = false;
    btnExtraerTexto.disabled = false;
    btnExtraerTexto.innerText = textoBotonOriginal;
    imageInput.disabled = false;
    cameraInput.disabled = false;
    btnTomarFoto.disabled = false;
    apiKeyInput.disabled = false;
  }
});
