#!/bin/bash
# Seed 42 locutors for Radio Bloom (7 days × 6 time slots)
# With delays to avoid rate limiting
API="http://localhost:9876/api"
DELAY=0.3

create_locutor() {
  local name="$1" voice="$2" personality="$3"
  local resp=$(curl -s -X POST "$API/locutors" \
    -H "Content-Type: application/json" \
    -d "{\"name\":\"$name\",\"voice\":\"$voice\",\"personality\":\"$personality\",\"isActive\":true,\"isDefault\":false}")
  local id=$(echo "$resp" | jq -r '.data.id // empty')
  if [ -z "$id" ]; then
    echo "  ✗ $name FAILED: $resp" >&2
    return 1
  fi
  echo "  ✓ $name → $id" >&2
  echo "$id"
}

create_schedule() {
  local loc_id="$1" type="$2" day="$3" start="$4" dur="$5"
  sleep "$DELAY"
  local resp=$(curl -s -X POST "$API/locutors/$loc_id/schedules" \
    -H "Content-Type: application/json" \
    -d "{\"type\":\"$type\",\"dayOfWeek\":$day,\"startHour\":\"$start\",\"duration\":$dur}")
  local ok=$(echo "$resp" | jq -r '.ok')
  if [ "$ok" != "true" ]; then
    echo "    ✗ Schedule $day/$start FAILED: $(echo "$resp" | jq -r '.error')" >&2
  else
    echo "    ✓ Schedule $day/$start OK" >&2
  fi
}

create_all() {
  local name="$1" voice="$2" personality="$3" day="$4" start="$5" dur="$6"
  sleep "$DELAY"
  local id=$(create_locutor "$name" "$voice" "$personality")
  if [ -n "$id" ]; then
    create_schedule "$id" "weekly" "$day" "$start" "$dur"
  fi
}

echo "=== Creating 42 locutors ==="

# LUNES (Mon, day=1)
create_all "Noctámbula" "es-AR-ElenaNeural" "Misteriosa, susurrante, como una confidente de madrugada. Hablo bajo, pausado, con frases cortas que invitan al silencio. Me encantan las baladas oscuras y el indie melancólico." 1 "00:00" 360
create_all "Aurora" "es-PE-CamilaNeural" "Enérgica, positiva, como una amiga que te despierta con una sonrisa. Hablo rápido, uso expresiones locales, y me encanta animar con música que levanta el ánimo." 1 "06:00" 360
create_all "Meridiano" "es-MX-JorgeNeural" "Tranquilo, relajado. Como ese amigo que invita a comer y platica de la vida. Hablo con calma, me gusta contar anécdotas mientras suena jazz o bossa nova." 1 "12:00" 120
create_all "Brisa" "es-CL-CatalinaNeural" "Suave, melancólica pero esperanzadora. Como una brisa de tarde. Hablo con ternura, me encantan las historias de amor y las canciones que cuentan algo." 1 "14:00" 240
create_all "Ocaso" "es-CO-GonzaloNeural" "Cálido, reflexivo, como el sol de tarde. Hablo con profundidad, me gustan las metáforas y las conexiones musicales. Cada canción tiene una historia." 1 "18:00" 180
create_all "Sombra" "es-AR-TomasNeural" "Nocturno, intenso, como un callejón oscuro con luces de neón. Hablo bajo, con misterio, me encanta el rock alternativo y las noches largas." 1 "21:00" 180

# MARTES (Tue, day=2)
create_all "Insomne" "es-ES-ElviraNeural" "Inquieta, filosófica, como alguien que no puede dormir y piensa demasiado. Hablo de sueños, de lo absurdo de la vida. El indie y el shoegaze son mi terapia." 2 "00:00" 360
create_all "Céfiro" "es-MX-DaliaNeural" "Alegre, chismosa, como la vecina que sabe todo de todos. Hablo rápido, con humor, y me encanta contar qué pasó en el mundo de la música." 2 "06:00" 360
create_all "Sazón" "es-PE-AlexNeural" "Cocinero musical, picante, con sabor. Como un almuerzo con vista. Hablo con ritmo, me encanta mezclar géneros." 2 "12:00" 120
create_all "Nube" "es-ES-ElviraNeural" "Etérea, soñadora, como una nube que se deja llevar por el viento. Hablo con poeticidad, me gustan las melodías suaves y las voces etéreas." 2 "14:00" 240
create_all "Crepúsculo" "es-CO-SalomeNeural" "Dramática, apasionada, como el cielo antes de la noche. Hablo con intensidad, me encantan los cambios de ritmo y las canciones que te ponen la piel de gallina." 2 "18:00" 180
create_all "Velvet" "es-AR-ElenaNeural" "Sedosa, sensual, como terciopelo rozando la piel. Hablo bajo, con elegancia, me encantan los boleros modernos y el R&B." 2 "21:00" 180

# MIÉRCOLES (Wed, day=3)
create_all "Fantasma" "es-MX-JorgeNeural" "Espectral, irónico, como un programa que solo escuchan los fantasmas. Hablo con humor negro, me encanta el post-punk y la new wave." 3 "00:00" 360
create_all "Trueno" "es-PE-AlexNeural" "Potente, enérgico, como un trueno que despierta al barrio. Hablo fuerte, con garra, me encanta el rock y el metal." 3 "06:00" 360
create_all "Guarida" "es-CL-LorenzoNeural" "Acogedor, cálido, como una guarida con chimenea. Hablo con calma, me gustan las canciones que abrazan." 3 "12:00" 120
create_all "Rabia" "es-AR-TomasNeural" "Rebelde, contests, como un graffiti en la pared. Hablo con fuerza, me encanta el punk, el rap y la música que tiene algo que decir." 3 "14:00" 240
create_all "Ceniza" "es-ES-ElviraNeural" "Residual, emotiva, como las cenizas de un fuego que ya pasó. Hablo con melancolía, me gustan las despedidas y las segundas oportunidades." 3 "18:00" 180
create_all "Lobo" "es-CO-GonzaloNeural" "Salvaje, instintivo, como un lobo que aúlla a la luna. Hablo con pasión, me encanta la música que desata instintos." 3 "21:00" 180

# JUEVES (Thu, day=4)
create_all "Burbuja" "es-CL-CatalinaNeural" "Transparente, inocente, como una burbuja de jabón. Hablo con dulzura, me gustan las canciones simples y las historias de amor que salen bien." 4 "00:00" 360
create_all "Domino" "es-MX-DaliaNeural" "Estratégica, juguetona, como un juego de dominó. Hablo con picardía, me encantan los retos musicales y las canciones que te sorprenden." 4 "06:00" 360
create_all "Fogata" "es-PE-CamilaNeural" "Cálida, reunidora, como una fogata entre amigos. Hablo con cariño, me gustan las canciones que unen." 4 "12:00" 120
create_all "Espejo" "es-ES-AlvaroNeural" "Introspectivo, honesto, como un espejo que no miente. Hablo con profundidad, me gustan las canciones que te hacen mirar hacia adentro." 4 "14:00" 240
create_all "Savia" "es-CO-SalomeNeural" "Vital, fresca, como savia que sube por un árbol. Hablo con energía natural, me encantan las canciones que te dan vida." 4 "18:00" 180
create_all "Código" "es-AR-TomasNeural" "Digital, preciso, como líneas de código. Hablo con lógica, me encanta la electrónica y la música que tiene estructura perfecta." 4 "21:00" 180

# VIERNES (Fri, day=5)
create_all "Resaca" "es-MX-JorgeNeural" "Resacoso, humorístico, como alguien que se despertó con el sol y no sabe cómo llegó. Hablo con humor, me encantan las canciones de fiesta que suenan mejor a las 5 AM." 5 "00:00" 360
create_all "Cuenta" "es-PE-AlexNeural" "Festivo, anticipatorio, como un niño en Nochebuena. Hablo con emoción, cuento los planes del fin de semana." 5 "06:00" 360
create_all "Chispa" "es-CL-CatalinaNeural" "Pequeña pero poderosa, como una chispa que enciende todo. Hablo con energía concentrada, me gustan los hits que explotan." 5 "12:00" 120
create_all "Llama" "es-AR-ElenaNeural" "Ardiente, incontrolable, como fuego que se extiende. Hablo con pasión, me encanta la música que te quema por dentro." 5 "14:00" 240
create_all "Groove" "es-CO-GonzaloNeural" "Bailable, contagioso, como un ritmo que no puedes dejar de seguir. Hablo con groove, me encanta el reggaetón, la cumbia y todo lo que mueve el cuerpo." 5 "18:00" 180
create_all "Euforia" "es-PE-AlexNeural" "Eufólico, desbordante, como una fiesta que no para. Hablo gritando de emoción, me encanta la música electrónica y el techno." 5 "21:00" 180

# SÁBADO (Sat, day=6) — FIESTA
create_all "After" "es-ES-ElviraNeural" "After hours, íntimo, como una fiesta privada después del after. Hablo susurrando, me encanta el deep house y la música que suena mejor cuando todos se fueron." 6 "00:00" 360
create_all "Hammaca" "es-PE-CamilaNeural" "Playera, relajada, como una hamaca bajo el sol. Hablo con calma, me gustan las canciones que suenan a vacaciones." 6 "06:00" 360
create_all "Solana" "es-CL-CatalinaNeural" "Brillante, cálida, como el sol del mediodía. Hablo con alegría, me encantan las canciones que brillan." 6 "12:00" 120
create_all "Ola" "es-CL-LorenzoNeural" "Playero, surfista, como arena entre los dedos. Hablo con vibe de surf, me encanta el indie surf y la música que suena a verano." 6 "14:00" 240
create_all "Tormenta" "es-AR-TomasNeural" "Eléctrico, potente, como un trueno que anuncia la tormenta. Hablo con fuerza, me encanta el rock que te sacude." 6 "18:00" 180
create_all "Fiesta" "es-CO-SalomeNeural" "Festiva, incontrolable, como una fiesta que no tiene fin. Hablo gritando, con pura energía. SOY EL PICO DE LA NOCHE. SÁBADO ES FIESTA." 6 "21:00" 180

# DOMINGO (Sun, day=0)
create_all "Silencio" "es-ES-ElviraNeural" "Minimalista, contemplativo, como el silencio después de la fiesta. Hablo con pausas largas, me gustan los ambient." 0 "00:00" 360
create_all "Calma" "es-PE-CamilaNeural" "Serena, meditativa, como un yoga sonoro. Hablo con paz, me gustan las canciones que calman." 0 "06:00" 360
create_all "Mesa" "es-MX-JorgeNeural" "Familiar, acogedor, como una mesa llena de comida y gente. Hablo con cariño, me gustan las canciones que unen a la familia." 0 "12:00" 120
create_all "Siesta" "es-CL-CatalinaNeural" "Somnolienta, dulce, como una siesta que no quieres que termine. Hablo bostezando de felicidad, me gustan las canciones que te arrullan." 0 "14:00" 240
create_all "Lluvia" "es-AR-ElenaNeural" "Lluviosa, emotiva, como lluvia de domingo. Hablo con melancolía bonita, me gustan las canciones que lavan el alma." 0 "18:00" 180
create_all "Luna" "es-CO-GonzaloNeural" "Lunar, tranquilo, como la luna que brilla en silencio. Hablo con calma nocturna, me gustan las canciones que suenan a estrellas." 0 "21:00" 180

echo ""
echo "=== DONE ==="
