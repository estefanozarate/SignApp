package io.sello.app.cose

import android.util.Base64
import com.facebook.react.bridge.*
import com.upokecenter.cbor.CBORObject
import com.upokecenter.cbor.CBORType
import org.json.JSONArray
import java.io.ByteArrayOutputStream
import java.math.BigInteger
import java.security.KeyFactory
import java.security.Signature
import java.security.spec.X509EncodedKeySpec
import java.util.zip.Inflater

/**
 * Módulo C — verificación criptográfica del QR.
 *
 * Formato del payload:  "SL1:" + Base45( zlib( COSE_Sign1 ) )
 *
 * COSE_Sign1 = 18([ protected: bstr, unprotected: map, payload: bstr, signature: bstr ])
 * protected  = { 1: alg (-7 ES256 | -8 EdDSA), 4: kid (bstr) }
 * payload    = { "sid": string, "org": string, "iat": int, "exp": int, "sgu": string }
 *
 * Nada de esto se acepta a medias: si algo no cuadra, se rechaza. No hay modo permisivo.
 */
class CoseModule(ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {

    override fun getName() = "SelloCose"

    private companion object {
        const val PREFIJO = "SL1:"
        const val ETIQUETA_COSE_SIGN1 = 18
        const val HDR_ALG = 1
        const val HDR_KID = 4
        const val ALG_ES256 = -7
        const val ALG_EDDSA = -8
        const val CONTEXTO_FIRMA = "Signature1"
        const val MARGEN_RELOJ_S = 60L // tolerancia al desfase del reloj del teléfono
    }

    @ReactMethod
    fun verificarQr(payload: String, trustListJson: String, ahoraSegundos: Double, promesa: Promise) {
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

            val kidBytes = cabecera(protegido, HDR_KID)?.GetByteString()
                ?: cabecera(sign1[1], HDR_KID)?.GetByteString()
                ?: run { fallar(promesa, "E_FORMATO", "El código no dice quién lo firmó."); return }
            val kid = hex(kidBytes)

            // 1. ¿Conocemos a este emisor?
            val emisor = buscarEmisor(trustListJson, kid)
            if (emisor == null) {
                fallar(promesa, "E_EMISOR_DESCONOCIDO", "El emisor no está en la lista de confianza.", kid); return
            }
            if (emisor.alg != alg) {
                fallar(promesa, "E_FIRMA", "El algoritmo no coincide con el registrado para el emisor.", kid); return
            }

            // 2. ¿La firma cubre exactamente estos bytes?
            //    Sig_structure = [ "Signature1", protected, external_aad(vacío), payload ]
            val aFirmar = CBORObject.NewArray().apply {
                Add(CONTEXTO_FIRMA)
                Add(protegidoBytes)
                Add(ByteArray(0))
                Add(payloadBytes)
            }.EncodeToBytes()

            if (!verificar(alg, emisor.spki, aFirmar, firmaCruda)) {
                fallar(promesa, "E_FIRMA", "La firma no es válida.", kid); return
            }

            // 3. Vigencia — con el reloj del teléfono, que puede ir corrido.
            val claims = CBORObject.DecodeFromBytes(payloadBytes)
            val exp = claims["exp"]?.AsInt64Value() ?: 0L
            val iat = claims["iat"]?.AsInt64Value() ?: 0L
            val ahora = ahoraSegundos.toLong()
            if (exp > 0 && ahora - MARGEN_RELOJ_S > exp) {
                fallar(promesa, "E_EXPIRADO", "El código ya caducó.", kid); return
            }
            if (iat > 0 && ahora + MARGEN_RELOJ_S < iat) {
                fallar(promesa, "E_EXPIRADO", "El código todavía no es válido.", kid); return
            }

            val sid = claims["sid"]?.AsString()
            val org = claims["org"]?.AsString()
            val sgu = claims["sgu"]?.AsString()
            if (sid.isNullOrBlank() || org.isNullOrBlank() || sgu.isNullOrBlank()) {
                fallar(promesa, "E_FORMATO", "Al código le faltan datos de sesión.", kid); return
            }
            // El signaling siempre por TLS: si no, no seguimos.
            if (!sgu.startsWith("wss://")) {
                fallar(promesa, "E_FORMATO", "El canal indicado no es seguro.", kid); return
            }

            promesa.resolve(Arguments.createMap().apply {
                putString("emisorKid", kid)
                putString("sessionId", sid)
                putString("origen", org)
                putDouble("emitidoEn", iat.toDouble())
                putDouble("expiraEn", exp.toDouble())
                putString("signalingUrl", sgu)
            })
        } catch (e: Exception) {
            fallar(promesa, "E_FORMATO", "No se pudo leer el código: ${e.message}")
        }
    }

    // ── sobre: prefijo → Base45 → zlib ──────────────────────────────────────

    private fun decodificarSobre(payload: String): ByteArray {
        val cuerpo = payload.removePrefix(PREFIJO).trim()
        val comprimido = Base45.decodificar(cuerpo)
        // 0x78 es la cabecera zlib; si no está, asumimos CBOR sin comprimir.
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

    // ── lista de confianza ──────────────────────────────────────────────────

    private data class Emisor(val kid: String, val alg: Int, val spki: ByteArray)

    private fun buscarEmisor(json: String, kid: String): Emisor? {
        val arr = JSONArray(json)
        for (i in 0 until arr.length()) {
            val o = arr.getJSONObject(i)
            if (!o.getString("kid").equals(kid, ignoreCase = true)) continue
            val alg = when (o.optString("alg", "ES256")) {
                "EdDSA" -> ALG_EDDSA
                else -> ALG_ES256
            }
            return Emisor(kid, alg, Base64.decode(o.getString("spkiB64"), Base64.NO_WRAP))
        }
        return null
    }

    // ── firma ───────────────────────────────────────────────────────────────

    private fun verificar(alg: Int, spki: ByteArray, mensaje: ByteArray, firma: ByteArray): Boolean = try {
        when (alg) {
            ALG_ES256 -> {
                val clave = KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(spki))
                Signature.getInstance("SHA256withECDSA").run {
                    initVerify(clave)
                    update(mensaje)
                    // COSE trae r||s crudos; la JCA espera DER.
                    verify(crudoADer(firma))
                }
            }
            ALG_EDDSA -> {
                val clave = KeyFactory.getInstance("Ed25519", "BC")
                    .generatePublic(X509EncodedKeySpec(spki))
                Signature.getInstance("Ed25519", "BC").run {
                    initVerify(clave); update(mensaje); verify(firma)
                }
            }
            else -> false
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

    /** Las cabeceras COSE son mapas con claves enteras: get(int) indexaría un array. */
    private fun cabecera(mapa: CBORObject, clave: Int): CBORObject? =
        if (mapa.type == CBORType.Map) mapa[CBORObject.FromObject(clave)] else null

    private fun hex(b: ByteArray) = b.joinToString("") { "%02x".format(it) }

    private fun fallar(p: Promise, codigo: String, mensaje: String, kid: String? = null) {
        val info = Arguments.createMap().apply { kid?.let { putString("kid", it) } }
        p.reject(codigo, mensaje, info)
    }

    init {
        // Ed25519 no está en el proveedor por defecto de Android; BC lo cubre.
        if (java.security.Security.getProvider("BC") == null) {
            java.security.Security.addProvider(org.bouncycastle.jce.provider.BouncyCastleProvider())
        }
    }
}
