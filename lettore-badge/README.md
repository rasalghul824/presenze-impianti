# Lettore badge per gli impianti

- `LettoreBadge/LettoreBadge.ino` – programma da caricare sull'ESP32 con Arduino IDE
- Guida 3D passo passo: apri `/guida-lettore.html` sul sito
- `guida.template.html` – sorgente della guida (il programma viene inserito al posto di %%SKETCH%%)

Per rigenerare la guida dopo aver modificato il programma:
python3 -c "s=open('lettore-badge/guida.template.html').read();k=open('lettore-badge/LettoreBadge/LettoreBadge.ino').read();open('public/guida-lettore.html','w').write(s.replace('%%SKETCH%%',k))"
