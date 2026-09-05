# Akıllı Video Sessizlik ve Kelime Kesici (Smart Video Editor)

Bu proje, manuel video kurguyu ve akıllı otomatik kırpmayı aynı arayüzde birleştiren web tabanlı bir video editörüdür. Otomatik kırpıcıda hazırlanan kesimler, video yeniden indirilip yüklenmeden tek tuşla manuel timeline'a aktarılabilir.

## Özellikler
- **İki Çalışma Alanı:** Manuel Edit ve Otomatik Kırpıcı birbirinden ayrı, tek uygulama içinde çalışır.
- **Manuel Timeline:** Sürüklenebilir oynatma kafası, gerçek klip küçük önizlemeleri, timeline yakınlaştırma, klip seçme, bölme, silme, hassas başlangıç-bitiş ayarı ve bağımsız klip zaman konumları.
- **Gerçek Ses Dalga Formu:** Her video klibinin alt bölümünde, klibin seçili kaynak aralığından FFmpeg ile üretilen gerçek ses dalga formu gösterilir. Kesme veya kırpma sonrası dalga formu yeni sınırlara göre yenilenir.
- **Çoklu Medya Yükleme:** “Dosya / video yükle” alanı video, resim ve ses dosyalarını kabul eder; aynı seçimde birden fazla dosya yüklenebilir.
- **Projelerim Medya Kütüphanesi:** Projelerim alanı timeline ile yan yana durur. Yüklenen video, resim ve müzikler tür ve süre bilgileriyle listelenir. Üç dosya türü de kendi timeline kanalına sürüklenebilir; video kartlarıyla birden fazla kaynak video aynı projede birleştirilebilir.
- **Ortak Sürükleme Önizlemesi:** Video, görsel, ses, metin, geçiş, video efekti, filtre ve sticker taşınırken imlecin yanında küçük ve sabit bir taşıma önizlemesi görünür; medya bu sırada oynatılmaz.
- **Görsel ve Ses Kanalları:** Projelerim'deki resim ve sesler sürükle-bırak ile GÖRSEL ve SES kanallarına yerleştirilebilir. Timeline'a eklenen medya klipleri yatay sürüklenerek zamanı değiştirilebilir; iki kenardaki tutamaçlarla süreleri kısaltılabilir.
- **Canlı Katman Önizlemesi:** Timeline'daki görseller videonun üzerinde taşınabilir, büyütülüp küçültülebilir ve döndürülebilir. Müzik ve ses dosyaları ana videoyla senkron biçimde canlı önizlenir.
- **Katmanlı Dışa Aktarma:** Görsel katmanlar seçilen konum ve sürelerde videoya işlenir; ek ses katmanları ana sesle karıştırılarak nihai çıktıya eklenir.
- **Serbest Klip Taşıma ve Mıknatıs:** Kesilmiş video klipleri timeline üzerinde sağa/sola taşınabilir ve aralarında boşluk bırakılabilir. Mıknatıs açıkken yakın klip kenarları otomatik hizalanır; kapalıyken serbest konumlandırma yapılır. Boşluklar dışa aktarılan videoda da korunur.
- **Editör Kısayolları:** B ile seçili video veya ses klibini kesme; Space ile oynat/duraklat; Delete ile silme; oklarla gezinme; Ctrl/Cmd+Z ile geri alma.
- **Kanal Kontrolleri:** Metin, görsel, video ve ses kanalları ayrı ayrı kilitlenebilir. Video ve katman görünürlüğü göz düğmesiyle, ana video sesi ve ek ses kanalı hoparlör düğmesiyle açılıp kapatılabilir; bu tercihler dışa aktarmaya da uygulanır.
- **Sağ Tık Menüsü:** Video, metin, görsel ve ses kliplerinin üzerinde sağ tıklayarak seçili öğe doğrudan silinebilir.
- **Platform Tuvali:** YouTube Full HD/2K/4K, Shorts-Reels-TikTok 9:16, kare 1:1, Instagram 4:5 ve sinematik 21:9 çıktı boyutları. Video seçilen tuvali merkezden kırparak tamamen doldurur; siyah kenar bırakmaz.
- **Timeline Yakınlaştırma:** Kaydırıcıya ek olarak timeline üzerinde Ctrl + fare tekerleği ile yakınlaştırma ve uzaklaştırma yapılır. Ölçek 0,02 px/sn seviyesine kadar iner; “Tümünü sığdır” uzun projeyi tek tıkla görünür alana yerleştirir.
- **Zoom ve Saydamlık Keyframeleri:** Seçili video klibinde oynatma kafasının bulunduğu saniyeye ölçek, odak konumu ve saydamlık keyframe’i eklenebilir. Keyframeler klibin üzerinde tıklanabilir elmaslarla gösterilir; hareket eğrisi seçenekleriyle iki nokta arasında akıcı geçiş yapılır ve sonuç dışa aktarılan videoya işlenir. Aynı dönüşüm keyframeleri normal metinlere ve otomatik altyazılara da eklenebilir.
- **Kenar Takipli Oynatma Kafası:** Kırmızı oynatma kafası timeline'ın sol veya sağ kenarına sürüklendiğinde çizelge otomatik kayar; kafa görünür kalır.
- **Çok Katmanlı Metin Timeline'ı:** 30 hazır metin stili tıklanarak veya sürükle-bırak ile videonun üstündeki METİN kanalına eklenebilir. Aynı zamandaki metinler ayrı satırlara ve ayrı ekran konumlarına yerleşir; seçili metin önizlemede taşınabilir, köşe tutamacıyla ölçeklendirilebilir ve dönüş tutamacıyla döndürülebilir. Yazı, renk, çerçeve, boyut, konum ve süre ayarları değiştirilebilir; metinler dışa aktarılan videoya işlenir.
- **Otomatik Türkçe / English Altyazı:** Seçili video klibinin Video sekmesindeki Otomatik altyazı alanı konuşmayı müzik ve sessizlikten ayırır. Hedef dil Türkçe veya English seçilebilir; her cümle ALTYAZI kanalına ayrı bir timeline klibi olarak eklenir. Altyazılar hazır metin stillerinden birini kullanır, timeline üzerinde taşınıp kısaltılabilir ve seçiliyken metni, stili, rengi ve yazı boyutu değiştirilebilir. English → Türkçe çeviri yerel Argos modeliyle yapılır ve çıktı renderına işlenir.
- **Tek Araç Paneli:** 30 metin stili, 30 geçiş, 60 klip animasyonu, 50 video efekti, 50 filtre ve 100 sticker aynı paneldeki altı ayrı sekmeyle açılır. Klip animasyonları karttan timeline’daki video klibine sürüklenir; Fade In ve Fade Out dahil kartların tam adları görünür ve taşıma sırasında küçük bir önizleme açılır.
- **Klip Bazlı Video Efektleri:** 50 ayrı video efekti karttan timeline'daki video klibinin üzerine sürüklenerek uygulanır. Efekt timeline klibinde görünür, canlı önizlemeye ve dışa aktarılan videoya işlenir.
- **Klip Bazlı Filtreler:** 50 ayrı renk filtresi video kliplerine sürüklenir; canlı önizleme ve dışa aktarma aynı filtreyi kullanır.
- **Gelişmiş Seçili Klip Ayarları:** Timeline'da bir video klibine tıklanınca Video, Ses, Hız, Animasyon, Ayarla ve Yapay zeka stili sekmeleri açılır. Video sekmesinde dönüşüm, çevirme, chroma key, karıştırma, sabitleme, keskinleştirme, gürültü azaltma, titreşim azaltma, optik akış, hareket bulanıklığı, otomatik kadraj ve yeniden ışıklandırma; Ses sekmesinde ses düzeyi, giriş-çıkış, normalleştirme, konuşma iyileştirme, gürültü azaltma, ses değiştirici, denge ve kanal doldurma; Ayarla sekmesinde Temel, HSL, Kavisler, Renk tekerleği ve Maske kontrolleri bulunur. Desteklenen ayarlar canlı önizlemeye ve dışa aktarılan videoya uygulanır; harici yapay zekâ modeli gerektiren seçenekler yanlış bir çalışma izlenimi vermemesi için açıkça pasif gösterilir.
- **Yan Yana Klip Düzenleme:** Geniş ekranlarda video oynatıcı solda, seçili klip ayarları sağda ve Düzenleme Araçları klip ayarlarının hemen altında açılır. Video adı, tuval biçimi, kısayollar, süre ve proje özeti oynatıcının üstünde kalır; dışa aktarma düğmesi sağ üstte sabittir. Dar ekranlarda düzen otomatik olarak alt alta döner.
- **Canlı Ses İşleme:** Ses normalleştirme, konuşma geliştirme ve gürültü azaltma Web Audio üzerinden canlı önizlenir; FFmpeg tarafında daha güçlü filtrelerle nihai çıktıya işlenir. Ses düzeyi %200'e kadar gerçek kazanç uygular. Fade in/fade out süreleri timeline klibinin üzerinde yeşil ve kırmızı eğimli alanlarla gösterilir.
- **Fırçalı Arka Plan Maskesi:** Fırçalı maske açıldığında video ekranı üzerinde boyama yapılabilir. Kullanıcı boyanan alanın kalmasını veya silinmesini seçebilir; fırça boyutu, son çizgiyi geri alma ve maskeyi temizleme kontrolleri bulunur. Boyama taslak olarak kalır; **Arka planı sil** düğmesine basıldığında canlı önizlemeye ve dışa aktarılan videoya uygulanır.
- **Konumlandırılabilir Video Maskeleri:** Daire, elips ve iç çerçeve maskelerinin boyutu, yatay/dikey konumu ve kenar yumuşatması ayarlanabilir. Projelerim alanındaki bir resim maske yuvasına sürüklenirse resim seçilen şeklin içinde önizlenir ve aynı maske dışa aktarmaya işlenir.
- **Sticker Kanalı:** 100 farklı sticker STICKER kanalına sürüklenir. Süreleri timeline'da ayarlanabilir; önizlemede taşınabilir, ölçeklendirilebilir ve döndürülebilir; dışa aktarılan videoya işlenir.
- **Proje Kaydı ve Çoklu Timeline:** Yeni proje oluşturulabilir, tüm medya ve düzenleme durumu adlandırılarak diske kaydedilebilir ve elektrik/kapanma durumuna karşı tarayıcıda otomatik kurtarma tutulur. Tek proje içinde “Ana video”, “Shorts” gibi birden fazla timeline oluşturulup sekmelerden geçiş yapılabilir.
- **Sürükle-Bırak Geçişler:** 30 farklı geçiş kartı iki kesilmiş klibin arasındaki birleşme noktasına bırakılır. Mor alan geçiş süresinin tamamını video kanalında gösterir. Bir sonraki video karesi önceden hazırlanır ve ana oynatıcı kaynak değiştirirken geçiş katmanı ekranda tutulur; görüntü ile ses çapraz geçişi dışa aktarılan videoya gerçek olarak uygulanır.
- **Tek Tıkla Aktarım:** Otomatik analiz sonucu “Manuel Editöre Gönder” düğmesiyle doğrudan timeline'a aktarılır.
- **Geri Alma ve Sıfırlama:** Manuel timeline işlemleri geri alınabilir veya orijinal videoya döndürülebilir.
- **Sadece Sessizlik Kesimi:** Kelime girilmezse AI modeli yüklenmez, saniyeler içinde sessizlikler tespit edilir (FFmpeg üzerinden).
- **Kelime + Sessizlik Kesimi:** Kelime girilirse `faster-whisper` AI modeli devreye girer, kelimelerin zaman damgalarını bulur ve sessizliklerle birleştirir.
- **Canlı Önizleme (Zero-Render):** Video render alınmadan tarayıcı üzerinden canlı kesilmiş gibi izlenebilir (Jump Cut).
- **Gerçek Zamanlı İlerleme:** SSE (Server-Sent Events) ile backend tarafındaki işlemler log konsoluna ve progress bar'a anlık yansır.
- **Ayrıntılı Dışa Aktarma:** Dışa aktarma penceresinde 24/25/30/50/60 FPS, taslak–en yüksek kalite ve MP4, MKV, MOV, WebM, GIF veya yalnızca ses için MP3 seçilebilir. **Render al** düğmesi seçilen çözünürlük, FPS, kalite ve biçimi gerçek FFmpeg çıktısına uygular.

## Kurulum ve Çalıştırma

### Windows 10/11 — kolay kurulum

Windows bilgisayarda proje klasörünü ZIP'ten tamamen çıkartın. Python 3.11 64-bit kuruluysa sırasıyla:

1. İlk kullanımda **`WINDOWS_KUR.bat`** dosyasına çift tıklayın.
2. Sonraki kullanımlarda **`WINDOWS_BASLAT.bat`** dosyasına çift tıklayın.
3. Uygulama tarayıcıda otomatik olarak **http://127.0.0.1:4242** adresinde açılır.

Windows kurulumu ayrı bir `.venv-windows` ortamı oluşturur. FFmpeg ve FFprobe sistemde yoksa projenin `tools/ffmpeg/bin` klasörüne otomatik indirilir; yönetici izni veya sistem PATH değişikliği gerekmez. Ayrıntılar için `WINDOWS_OKU_BENI.txt` dosyasına bakın.

Yeni ve eski FFmpeg sürümlerindeki filtre-dosyası komut farkı otomatik algılanır. Windows'ta görülen `2880417800 / 0xABAFB008` hatası için güncel paketi kullanıp `WINDOWS_KUR.bat` dosyasını yeniden çalıştırın; render başarısız olursa arayüz artık gerçek FFmpeg hata ayrıntısını da gösterir.

Windows FFmpeg'in tek satırda 64 KB'tan büyük tanılama çıktısı üretmesi de desteklenir. Çıktı güvenli parçalar hâlinde işlendiği için `Separator is not found, and chunk exceed the limit` hatası render işlemini durdurmaz.

Windows render motoru bellek taşmasını önlemek için filtre işlemcilerini ve encoder iş parçacıklarını sınırlar; x264 lookahead tamponu da küçültülür. Windows'un işaretsiz gösterdiği `4294967284` (`-12`, yetersiz bellek) hatasında gerçek hata satırı encoder özetinden ayrı tutulur.

> Projeyle birlikte gelen macOS/Linux `venv` klasörünü Windows'ta kullanmayın. Sanal ortamlar taşınabilir değildir; `WINDOWS_KUR.bat` Windows'a uygun ortamı yeniden oluşturur.

### Gereksinimler
- Python 3.10 veya üzeri
- Sisteminizde **FFmpeg** ve **FFprobe** kurulu ve PATH'e eklenmiş olmalıdır.
  - macOS için: `brew install ffmpeg`
  - Windows için: [FFmpeg İndir](https://ffmpeg.org/download.html)
  - Ubuntu/Debian: `sudo apt install ffmpeg`

### 1. Kütüphanelerin Yüklenmesi
Proje dizininde (bu README dosyasının bulunduğu dizin) terminali açın ve gerekli kütüphaneleri yükleyin:

```bash
pip install -r requirements.txt
```

*(Not: `faster-whisper` modeli CPU üzerinde çalışacak şekilde ayarlanmıştır ve ilk konuşma analizinde otomatik indirilir. Windows'ta otomatik altyazı düşük bellekli `tiny` modelle ayrı, korumalı bir işlemde çalışır; model/codec hatası editörü kapatmaz. English → Türkçe altyazı için kullanılan yerel Argos dil paketi de ilk ihtiyaçta bir kez indirilir.)*

### 2. Uygulamanın Başlatılması
Terminale aşağıdaki komutu girerek FastAPI sunucusunu başlatın:

```bash
python app.py
```
*(Alternatif olarak: `uvicorn app:app --host 0.0.0.0 --port 4242` komutunu da kullanabilirsiniz.)*

### 3. Kullanım
Tarayıcınızı açın ve **http://localhost:4242** adresine gidin.
1. Manuel kurgu için **Manuel Edit** alanındaki **Dosya / video yükle** bölümünden ana videonuzu ve kullanacağınız resim/ses dosyalarını yükleyin.
2. Projelerim alanındaki video, resim veya sesi kendi VİDEO/GÖRSEL/SES kanalına sürükleyin; timeline üzerinde yatay sürükleyerek zamanını değiştirin.
3. Otomatik kesim için **Otomatik Kırpıcı** alanına geçin ve videoyu seçin.
4. Sessizlik ve isteğe bağlı kelime ayarlarını yapıp **Videoyu Yükle ve Analiz Et** düğmesine basın.
5. Sonucu doğrudan indirebilir veya **Manuel Editöre Gönder** ile aynı videoyu manuel timeline'da düzenlemeye devam edebilirsiniz.
6. Manuel timeline'da bir video klibini seçip **Video → Otomatik altyazı** bölümünü açın; Türkçe veya English hedef dilini ve metin stilini seçerek konuşmaları ALTYAZI kanalına ekleyin.
