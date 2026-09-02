package io.sello.app.cose

import android.util.Base64
import com.facebook.react.bridge.*
import com.upokecenter.cbor.CBORObject
import com.upokecenter.cbor.CBORType
import org.json.JSONArray
import java.io.ByteArrayOutputStream
import java.math.BigInteger
import java.security.KeyFactory
import java.security.MessageDigest
import java.security.Signature
import java.security.spec.X509EncodedKeySpec
import java.util.zip.Inflater

/**
 * Verificación criptográfica del QR.
 *
 * Formato:  "SL1:" + Base45( zlib( COSE_Sign1 ) )
 *
 * COSE_Sign1 = 18([ protected: bstr, unprotected: map, payload: bstr, signature: bstr ])
 * protected  = { 1: alg (-7 ES256), 4: kid (bstr) }
 *
 * payload (mapa con claves de texto):
 *   "typ"  "pair" | "aprb"
 *   "org"  origen que pide (dominio del navegador)
 *   "sid"  identificador de sesión
 *   "iat"  "exp"
 *   "sgu"  canal de retorno
 *   pair:  "bpk"  clave pública del navegador (SPKI)
 *   aprb:  "act"  qué se aprueba, en texto para el usuario
 *          "acc"  cuenta (opcional)
 *          "chl"  nonce del navegador
 *
 * Dos anclas de confianza distintas, a propósito:
 *
 * - Un QR de vinculación va AUTOFIRMADO con la clave que lleva dentro. No
 *   prueba quién es: solo prueba que quien lo emitió tiene esa privada. La
 *   confianza la pone el usuario al aceptar la vinculación viendo el origen.
 *   Por eso el kid tiene que ser la huella real de la clave: sin eso, dos
 *   navegadores distintos podrían reclamar el mismo identificador.
 *
 * - Un QR de aprobación se verifica contra la clave del navegador YA
 *   vinculado. Ahí sí hay autenticación: un suplantador no está en la lista.
 */
class CoseModule(ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {

    override fun getName() = "SelloCose"

    private companion object {
        const val PREFIJO = "SL1:"
        const val ETIQUETA_COSE_SIGN1 = 18
        const val HDR_ALG = 1
        const val HDR_KID = 4
        const val ALG_ES256 = -7
        const val CONTEXTO_FIRMA = "Signature1"
        const val MARGEN_RELOJ_S = 60L

        /**
         * Separador de dominio del reto. Lo que el teléfono firma es este
         * prefijo seguido del payload EXACTO que verificó y mostró en pantalla:
         * lo que el usuario ve es literalmente lo que se firma, y la firma no
         * puede reutilizarse fuera de este protocolo.
         */
        val PREFIJO_RETO = "sello/aprobacion/v1".toByteArray()
    }

    @ReactMethod
    fun verificarQr(payload: String, vinculosJson: String, ahoraSegundos: Double, promesa: Promise) {
        try {
            val crudo = decodificarSobre(payload)
            val sign1 = CBORObject.DecodeFromBytes(crudo).let {
                if (it.HasMostOuterTag(ETIQUETA_COSE_SIGN1)) it.UntagOne() else it
            }
            if (sign1.type != CBORType.Array || sign1.size() != 4) {
                fallar(promesa, "E_FORMATO", "El código no es un COSE_Sign1."); return
            }

            val protegidoBytes = sign1[0].GetByteString()
            val protegido = CBORObject.DecodeFromBytes(protegidoBytes)
            val payloadBytes = sign1[2].GetByteString()
            val firmaCruda = sign1[3].GetByteString()

            val alg = cabecera(protegido, HDR_ALG)?.AsInt32Value()
                ?: run { fallar(promesa, "E_FORMATO", "Falta el algoritmo en la cabecera."); return }
            if (alg != ALG_ES256) {
                fallar(promesa, "E_FIRMA", "Algoritmo no soportado."); return
            }

            val kidBytes = cabecera(protegido, HDR_KID)?.GetByteString()
                ?: cabecera(sign1[1], HDR_KID)?.GetByteString()
                ?: run { fallar(promesa, "E_FORMATO", "El código no dice quién lo firmó."); return }
            val kid = hex(kidBytes)

            val claims = CBORObject.DecodeFromBytes(payloadBytes)
            if (claims.type != CBORType.Map) {
                fallar(promesa, "E_FORMATO", "El contenido no tiene la forma esperada."); return
            }
            val tipo = texto(claims, "typ") ?: "aprb"
            val org = texto(claims, "org")
            val sid = texto(claims, "sid")
            if (org.isNullOrBlank() || sid.isNullOrBlank()) {
                fallar(promesa, "E_FORMATO", "Al código le faltan datos de sesión.", kid); return
            }

            // ── de dónde sale la clave con la que se verifica ────────────────
            val spki: ByteArray = if (tipo == "pair") {
                val bpk = claims[CBORObject.FromObject("bpk")]?.GetByteString()
                    ?: run { fallar(promesa, "E_FORMATO", "El código de vinculación no trae clave.", kid); return }
                // El kid debe ser la huella de la propia clave; si no, el
                // identificador sería reclamable por cualquiera.
                if (hex(sha256(bpk).copyOfRange(0, 8)) != kid) {
                    fallar(promesa, "E_FIRMA", "El identificador no corresponde a la clave.", kid); return
                }
                bpk
            } else {
                buscarVinculo(vinculosJson, kid, org)
                    ?: run {
                        fallar(promesa, "E_NO_VINCULADO",
                            "Este navegador no está vinculado a tu teléfono.", kid); return
                    }
            }

            // ── la firma cubre exactamente estos bytes ──────────────────────
            val aVerificar = CBORObject.NewArray().apply {
                Add(CONTEXTO_FIRMA)
                Add(protegidoBytes)
                Add(ByteArray(0))
                Add(payloadBytes)
            }.EncodeToBytes()

            if (!verificar(spki, aVerificar, firmaCruda)) {
                fallar(promesa, "E_FIRMA", "La firma no es válida.", kid); return
            }

            // ── vigencia ───────────────────────────────────────────
            val exp = entero(claims, "exp")
            val iat = entero(claims, "iat")
            val ahora = ahoraSegundos.toLong()
            if (exp > 0 && ahora - MARGEN_RELOJ_S > exp) {
                fallar(promesa, "E_EXPIRADO", "El código ya caducó.", kid); return
            }
            if (iat > 0 && ahora + MARGEN_RELOJ_S < iat) {
                fallar(promesa, "E_EXPIRADO", "El código todavía no es válido.", kid); return
            }

            val sgu = texto(claims, "sgu")
            if (sgu != null && !(sgu.startsWith("https://") || sgu.startsWith("http://127.0.0.1"))) {
                // http:// solo se tolera en loopback, donde no hay red que espiar.
                fallar(promesa, "E_FORMATO", "La dirección de respuesta no es segura.", kid); return
            }

            promesa.resolve(Arguments.createMap().apply {
                putString("tipo", tipo)
                putString("kid", kid)
                putString("origen", org)
                putString("sessionId", sid)
                putDouble("emitidoEn", iat.toDouble())
                putDouble("expiraEn", exp.toDouble())
                sgu?.let { putString("signalingUrl", it) }
                putString("clavePublicaB64", b64(spki))
                texto(claims, "act")?.let { putString("accion", it) }
                texto(claims, "acc")?.let { putString("cuenta", it) }
                // El reto que se firmará: prefijo de dominio + el payload
                // verificado, tal cual. Lo que se muestra es lo que se firma.
                putString("retoB64", b64(PREFIJO_RETO + payloadBytes))
            })
        } catch (e: Exception) {
            fallar(promesa, "E_FORMATO", "No se pudo leer el código: ${e.message}")
        }
    }

    // ── sobre: prefijo → Base45 → zlib ────────────────────────────────

    private fun decodificarSobre(payload: String): ByteArray {
        val cuerpo = payload.removePrefix(PREFIJO).trim()
        val comprimido = Base45.decodificar(cuerpo)
        return if (comprimido.size > 2 && comprimido[0] == 0x78.toByte()) inflar(comprimido) else comprimido
    }

    private fun inflar(datos: ByteArray): ByteArray {
        val inflater = Inflater()
        inflater.setInput(datos)
        val salida = ByteArrayOutputStream(datos.size * 3)
        val buffer = ByteArray(4096)
        try {
            while (!inflater.finished()) {
                val n = inflater.inflate(buffer)
                if (n == 0 && inflater.needsInput()) break
                salida.write(buffer, 0, n)
            }
        } finally {
            inflater.end()
        }
        return salida.toByteArray()
    }

    // ── navegadores vinculados ─────────────────────────────────────

    /** El vínculo ata clave Y origen: una clave vinculada para un sitio no sirve para otro. */
    private fun buscarVinculo(json: String, kid: String, origen: String): ByteArray? {
        val arr = JSONArray(json)
        for (i in 0 until arr.length()) {
            val o = arr.getJSONObject(i)
            if (!o.getString("kid").equals(kid, ignoreCase = true)) continue
            if (!o.getString("origen").equals(origen, ignoreCase = true)) continue
            return Base64.decode(o.getString("spkiB64"), Base64.NO_WRAP)
        }
        return null
    }

    // ── firma ───────────────────────────────────────────────────

    private fun verificar(spki: ByteArray, mensaje: ByteArray, firma: ByteArray): Boolean = try {
        val clave = KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(spki))
        Signature.getInstance("SHA256withECDSA").run {
            initVerify(clave)
            update(mensaje)
            // COSE trae r||s crudos; la JCA espera DER.
            verify(crudoADer(firma))
        }
    } catch (e: Exception) {
        false
    }

    /** r||s de 32 bytes cada uno → SEQUENCE { INTEGER r, INTEGER s }. */
    private fun crudoADer(firma: ByteArray): ByteArray {
        require(firma.size == 64) { "Firma ES256 de tamaño inesperado: ${firma.size}" }
        val r = BigInteger(1, firma.copyOfRange(0, 32)).toByteArray()
        val s = BigInteger(1, firma.copyOfRange(32, 64)).toByteArray()
        val cuerpo = ByteArrayOutputStream().apply {
            write(0x02); write(r.size); write(r)
            write(0x02); write(s.size); write(s)
        }.toByteArray()
        return ByteArrayOutputStream().apply {
            write(0x30); write(cuerpo.size); write(cuerpo)
        }.toByteArray()
    }

    // ── utilidades ──────────────────────────────────────────────

    /** Las cabeceras COSE son mapas con claves enteras: get(int) indexaría un array. */
    private fun cabecera(mapa: CBORObject, clave: Int): CBORObject? =
        if (mapa.type == CBORType.Map) mapa[CBORObject.FromObject(clave)] else null

    private fun texto(mapa: CBORObject, clave: String): String? =
        mapa[CBORObject.FromObject(clave)]?.takeIf { it.type == CBORType.TextString }?.AsString()

    private fun entero(mapa: CBORObject, clave: String): Long =
        mapa[CBORObject.FromObject(clave)]?.takeIf { it.isNumber }?.AsInt64Value() ?: 0L

    private fun sha256(b: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(b)

    private fun hex(b: ByteArray) = b.joinToString("") { "%02x".format(it) }

    private fun b64(b: ByteArray) = Base64.encodeToString(b, Base64.NO_WRAP)

    private fun fallar(p: Promise, codigo: String, mensaje: String, kid: String? = null) {
        val info = Arguments.createMap().apply { kid?.let { putString("kid", it) } }
        p.reject(codigo, mensaje, info)
    }
}
