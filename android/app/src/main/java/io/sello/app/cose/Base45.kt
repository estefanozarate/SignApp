package io.sello.app.cose

/**
 * Base45 (RFC 9285). Se usa porque el modo alfanumérico del QR lo codifica
 * mucho más denso que Base64: menos módulos, código más fácil de leer de lejos.
 */
object Base45 {
    private const val ALFABETO = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ \$%*+-./:"

    fun decodificar(texto: String): ByteArray {
        val valores = texto.map {
            ALFABETO.indexOf(it).also { i ->
                require(i >= 0) { "Carácter fuera del alfabeto Base45: '$it'" }
            }
        }
        require(valores.size % 3 != 1) { "Longitud Base45 inválida" }

        val salida = ArrayList<Byte>(valores.size / 3 * 2)
        var i = 0
        while (i + 2 < valores.size) {
            val n = valores[i] + valores[i + 1] * 45 + valores[i + 2] * 45 * 45
            require(n <= 0xFFFF) { "Grupo Base45 fuera de rango" }
            salida.add((n / 256).toByte())
            salida.add((n % 256).toByte())
            i += 3
        }
        if (i + 1 < valores.size) {
            val n = valores[i] + valores[i + 1] * 45
            require(n <= 0xFF) { "Grupo Base45 final fuera de rango" }
            salida.add(n.toByte())
        }
        return salida.toByteArray()
    }
}
