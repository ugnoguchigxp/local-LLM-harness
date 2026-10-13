"""Synthetic, independently authored sentences with frozen split/label policy.

Each line is a Japanese sentence and its English counterpart, not a template
expanded by word substitution. Paired translations share a conversation and
stay in one partition. Topic/template groups are disjoint across partitions.
The label is the language of the whole sentence, not individual quoted words.
"""
import json
from pathlib import Path

TRAIN = {
    'everyday': '''
今朝は目覚ましが鳴る前に起きました。 | I woke up before my alarm went off this morning.
駅に向かう途中で友人に会いました。 | I met a friend on my way to the station.
午後から少し買い物に出かけます。 | I am going out to do some shopping this afternoon.
帰宅したらまず手を洗います。 | The first thing I do when I get home is wash my hands.
今日はいつもより早く眠れそうです。 | I think I can go to bed earlier than usual today.
鍵をどこに置いたか思い出せません。 | I cannot remember where I put my keys.
出かける前に財布を確認してください。 | Please check that you have your wallet before leaving.
明日の朝は私が窓を開けます。 | I will open the window tomorrow morning.
週末は何も予定を入れていません。 | I have not made any plans for the weekend.
電話が鳴りましたが、すぐには出られませんでした。 | The phone rang, but I could not answer it right away.
朝食の後で近所を散歩しました。 | I took a walk around the neighborhood after breakfast.
午後の予定を一つ取り消しました。 | I canceled one of my appointments for the afternoon.
靴を履いたところで忘れ物に気づきました。 | I noticed I had forgotten something just as I put on my shoes.
今夜は家でゆっくり過ごしたいです。 | I want to spend a quiet evening at home tonight.
いつもの道が工事中だったので遠回りしました。 | I took a detour because my usual route was under construction.
小さな用事でも手帳に書くようにしています。 | I try to write even small errands in my planner.
昼休みに郵便局まで歩いてきました。 | I walked to the post office during my lunch break.
急がなくても、約束の時間には間に合います。 | We can make it to the appointment without rushing.
先に出発して、入口で待っていてください。 | Please leave ahead of me and wait at the entrance.
少し休んでから次の用事を済ませます。 | I will take care of the next errand after a short rest.
''',
    'food': '''
冷蔵庫に残っている野菜でスープを作ります。 | I will make soup with the vegetables left in the refrigerator.
お湯が沸いたら麺を入れてください。 | Add the noodles when the water comes to a boil.
このパンは外が硬くて中が柔らかいです。 | This bread is crusty on the outside and soft inside.
砂糖を少し減らしたら、ちょうどよい甘さになりました。 | Reducing the sugar a little gave it just the right sweetness.
夕食には魚を焼こうと思っています。 | I am thinking of grilling fish for dinner.
塩を入れる前に味を見ましょう。 | Let us taste it before adding salt.
温かいうちに召し上がってください。 | Please enjoy it while it is still warm.
注文した料理はまだ来ていません。 | The food I ordered has not arrived yet.
この店では持ち帰りもできますか。 | Does this restaurant offer takeout as well?
辛いものが苦手なので、別の料理にします。 | I do not handle spicy food well, so I will choose something else.
コーヒーにはミルクだけ入れます。 | I add only milk to my coffee.
炊きたてのご飯を小さな茶碗によそいました。 | I served the freshly cooked rice in a small bowl.
昨日のカレーを昼食に温め直しました。 | I reheated yesterday's curry for lunch.
果物を切るための小さなナイフを探しています。 | I am looking for a small knife to cut the fruit.
材料を全部そろえてから調理を始めます。 | I start cooking after gathering all the ingredients.
玉ねぎが透き通るまでゆっくり炒めます。 | Cook the onions slowly until they turn translucent.
食器を下げてもよろしいでしょうか。 | May I clear the dishes?
お弁当の中身が片寄らないように詰めました。 | I packed the lunch box so its contents would stay in place.
食後に温かいお茶を飲むのが好きです。 | I like drinking warm tea after a meal.
予約した席を窓側に変更できますか。 | Could you change our reserved table to one by the window?
''',
    'transport': '''
次の電車は三番ホームから出ます。 | The next train leaves from platform three.
乗り換えには少なくとも十分かかります。 | The transfer takes at least ten minutes.
バス停の前には長い列ができていました。 | There was a long line in front of the bus stop.
切符を買う機械が一台故障しています。 | One of the ticket machines is out of order.
空港へはどの路線に乗ればよいですか。 | Which line should I take to the airport?
終点まで乗ってから反対側に渡ります。 | Ride to the last stop and then cross to the other side.
運転中は携帯電話を手に取りません。 | I do not pick up my phone while driving.
自転車の空気を入れてから出発しました。 | I pumped up the bicycle tires before setting off.
この交差点を左に曲がってください。 | Please turn left at this intersection.
目的地の手前でタクシーを降りました。 | I got out of the taxi just before reaching the destination.
道路が混んでいるので到着が遅れそうです。 | Traffic is heavy, so it looks like I will arrive late.
改札を出たところに案内板があります。 | There is an information board just outside the ticket gates.
座席の番号をもう一度確認しましょう。 | Let us check the seat numbers again.
急行はこの駅には停車しません。 | The express train does not stop at this station.
小さな荷物は膝の上に置きました。 | I kept my small bag on my lap.
帰りの切符も一緒に購入しました。 | I bought the return ticket at the same time.
雨の日は歩道が滑りやすくなります。 | The sidewalk gets slippery on rainy days.
出発時刻が掲示板に表示されました。 | The departure time appeared on the board.
車を降りるときに傘を忘れました。 | I forgot my umbrella when getting out of the car.
駅の出口が多くて、少し迷いました。 | I got a little lost because the station had so many exits.
''',
    'work': '''
会議の資料を全員に共有しました。 | I shared the meeting materials with everyone.
この件は担当者に確認してから返事をします。 | I will reply after checking this with the person responsible.
締め切りを一日だけ延ばしてもらえますか。 | Could you extend the deadline by just one day?
午前の会議は予定より早く終わりました。 | The morning meeting ended earlier than planned.
作業の優先順位を一緒に決めましょう。 | Let us decide on the priorities together.
見積もりには送料も含まれています。 | The estimate includes the shipping cost.
書類の最後に署名をお願いします。 | Please sign at the end of the document.
担当が変わったことを先方へ伝えました。 | I informed the client that the person in charge had changed.
まだ確認していない項目が二つあります。 | There are two items I have not checked yet.
休憩の後で残りの作業に取りかかります。 | I will begin the remaining work after the break.
この数字は前の月と比べる必要があります。 | We need to compare this figure with the previous month.
議事録に決定事項だけをまとめてください。 | Please summarize only the decisions in the meeting minutes.
途中までできた資料を先に送ります。 | I will send the partially finished materials first.
新しい担当者へ手順を説明しました。 | I explained the procedure to the new person in charge.
不明な点は遠慮なく質問してください。 | Feel free to ask about anything that is unclear.
会議室を午後二時から予約しています。 | I have reserved the meeting room from two in the afternoon.
電話では伝えにくいので、文章にまとめます。 | It is difficult to explain over the phone, so I will put it in writing.
結論から先に説明していただけますか。 | Could you explain the conclusion first?
持ち帰った課題を次回までに整理します。 | I will organize the issues we took away before the next meeting.
今日は予定どおりに仕事を終えられました。 | I finished work on schedule today.
''',
    'software': '''
設定画面で通知を無効にしてください。 | Please disable notifications in the settings screen.
保存する前にファイル名を確認します。 | I check the file name before saving.
GitHubに修正内容を送信しました。 | I submitted the changes to GitHub.
ブラウザーを閉じてもダウンロードは続きますか。 | Will the download continue if I close the browser?
APIの応答には必要な項目が足りません。 | The API response is missing a required field.
画面に「Save changes」と表示されています。 | The screen says "Save changes".
更新後も以前の設定を引き継ぎました。 | The previous settings were retained after the update.
パスワードを忘れた場合はこちらを開いてください。 | Open this page if you have forgotten your password.
読み込みが終わるまで操作を待ってください。 | Please wait until loading finishes before using the controls.
ログには同じエラーが何度も出ています。 | The same error appears repeatedly in the log.
コピーしたURLを入力欄に貼り付けます。 | Paste the copied URL into the input field.
このアプリはインターネットなしでも使えます。 | This app can be used without an internet connection.
削除したファイルを元に戻せますか。 | Can I restore the deleted file?
新しいタブで説明書を開きました。 | I opened the instructions in a new tab.
JSONの構文に誤りがあるようです。 | There seems to be an error in the JSON syntax.
テストがすべて通ったので変更を確定します。 | All the tests passed, so I will finalize the changes.
「次へ」と書かれたボタンで別のページを開けます。 | The button labelled "次へ" opens another page.
英語のメッセージを日本語に翻訳しました。 | I translated the English message into Japanese.
バックアップの保存先を変更したいです。 | I would like to change where the backups are saved.
入力した内容は送信前に確認できます。 | You can review what you entered before submitting it.
''',
    'hardware': '''
USBケーブルを別の端子に挿しました。 | I plugged the USB cable into a different port.
CPUの使用率が急に上がりました。 | CPU usage suddenly increased.
画面の明るさを少し下げたいです。 | I would like to lower the screen brightness a little.
キーボードの一つのキーが反応しません。 | One key on the keyboard does not respond.
スピーカーから小さな雑音が聞こえます。 | I can hear a faint noise from the speakers.
電源を切ってからケーブルを抜きました。 | I unplugged the cable after turning off the power.
充電器を持ってくるのを忘れました。 | I forgot to bring my charger.
マイクの音量はどこで調整できますか。 | Where can I adjust the microphone volume?
SSDの空き容量が少なくなっています。 | The SSD is running low on free space.
プリンターの紙を補充してください。 | Please refill the printer paper.
電池を交換すると正常に動きました。 | It worked normally after I replaced the batteries.
机の下に延長コードを置いています。 | I keep an extension cord under the desk.
Bluetoothの接続をいったん解除しました。 | I disconnected Bluetooth temporarily.
この機器には説明書が付属していますか。 | Does this device come with an instruction manual?
画面を拭くための柔らかい布を使いました。 | I used a soft cloth to wipe the screen.
新しい機器を認識するまで少し時間がかかります。 | It takes a moment to recognize the new device.
ファンの音が前より大きくなった気がします。 | I feel that the fan has become louder than before.
有線で接続したら映像が安定しました。 | The video became stable when I used a wired connection.
この端子には無理に差し込まないでください。 | Please do not force the plug into this port.
GPUの温度を定期的に記録しています。 | I record the GPU temperature regularly.
''',
    'education': '''
わからない単語をノートに書き出しました。 | I wrote the unfamiliar words in my notebook.
宿題は授業の始めに提出してください。 | Please turn in the homework at the beginning of class.
例文を声に出して三回読みました。 | I read the example sentence aloud three times.
この問題は別の方法でも解けます。 | This problem can also be solved another way.
答えだけでなく考え方を説明しましょう。 | Explain your reasoning as well as the answer.
試験の日程が一週間後ろにずれました。 | The exam schedule was moved back by one week.
黒板の文字が後ろからは見えません。 | I cannot see the writing on the board from the back.
先生が配った資料をなくしてしまいました。 | I lost the handout the teacher gave us.
辞書を使わずに一度読んでみてください。 | Try reading it once without a dictionary.
毎日少しずつ復習するようにしています。 | I try to review a little every day.
二人ずつ組になって話し合います。 | We will discuss it in pairs.
次のページに練習問題があります。 | There are practice exercises on the next page.
授業で扱った内容を家族に説明しました。 | I explained what we covered in class to my family.
質問の意味を取り違えていました。 | I misunderstood the meaning of the question.
忘れないように大事な部分に線を引きました。 | I underlined the important parts so I would not forget them.
少し難しいですが、最後まで考えてみます。 | It is a little difficult, but I will keep thinking it through.
昨日習ったことを今日の課題で使います。 | We will use what we learned yesterday in today's assignment.
発音を聞いてから同じように繰り返してください。 | Listen to the pronunciation and then repeat it the same way.
授業の終わりに短い感想を書きました。 | I wrote a short reflection at the end of class.
勉強する場所を変えると集中できました。 | Changing where I studied helped me concentrate.
''',
    'home': '''
洗濯物を取り込んでから畳みます。 | I bring in the laundry before folding it.
棚の上に積んだ箱を片づけました。 | I put away the boxes piled on top of the shelf.
窓の近くに小さな椅子を置きたいです。 | I would like to put a small chair near the window.
掃除機の袋がいっぱいになっています。 | The vacuum cleaner bag is full.
玄関の電球を新しいものに替えました。 | I replaced the bulb in the entrance with a new one.
カーテンを洗ったら部屋が明るく感じます。 | The room feels brighter after I washed the curtains.
隣の部屋から話し声が聞こえました。 | I heard people talking in the next room.
冷たい空気が入るので戸を閉めてください。 | Please close the door because cold air is coming in.
家具を動かすときは床を傷つけないようにします。 | I try not to scratch the floor when moving furniture.
使わない物を箱にまとめておきました。 | I put the things I do not use together in a box.
床に落とした水をすぐに拭きました。 | I wiped up the water I spilled on the floor right away.
休日に部屋の模様替えをするつもりです。 | I plan to rearrange my room on my day off.
壁の時計が五分ほど遅れています。 | The clock on the wall is about five minutes slow.
この引き出しは途中で引っかかります。 | This drawer gets stuck halfway out.
大きな荷物は廊下に置かないでください。 | Please do not leave large packages in the hallway.
靴をそろえると玄関がすっきり見えます。 | Lining up the shoes makes the entrance look tidy.
空いている棚を一段使ってもよいですか。 | May I use one of the empty shelves?
ベランダに干したタオルがよく乾きました。 | The towels I hung on the balcony dried well.
台所の引き出しを整理していました。 | I was organizing the kitchen drawers.
夜は部屋の照明を少し暗くしています。 | I dim the room lights a little at night.
''',
    'weather': '''
朝から雲が広がっています。 | Clouds have been spreading across the sky since morning.
夕方になると風が冷たくなりました。 | The wind turned chilly in the evening.
雨がやんだので外へ出てみました。 | The rain stopped, so I stepped outside.
今日は薄手の上着で十分でした。 | A light jacket was enough today.
日なたと日陰では暖かさが違います。 | It feels warmer in the sun than in the shade.
遠くの山に雪が残っていました。 | There was still snow on the distant mountains.
窓を開けると涼しい風が入りました。 | A cool breeze came in when I opened the window.
傘を持っていったほうがよさそうです。 | It looks like we should take umbrellas.
空が暗くなってきたので早めに帰りました。 | The sky was getting dark, so I went home early.
寒さよりも強い風が気になります。 | The strong wind bothers me more than the cold.
朝の霧で向こう側がよく見えませんでした。 | I could not see the other side clearly through the morning fog.
雨上がりの道に水たまりができています。 | There are puddles on the road after the rain.
乾いた空気で唇が少し荒れました。 | The dry air left my lips a little chapped.
昨日より気温が二度下がったそうです。 | I heard the temperature dropped by two degrees from yesterday.
昼ごろには雲の間から光が差しました。 | Light broke through the clouds around noon.
木の葉が風に揺れていました。 | The leaves were swaying in the wind.
今日は室内のほうが暖かく感じます。 | It feels warmer indoors today.
雪が降り始めたころに駅へ着きました。 | I reached the station just as it started to snow.
濡れた靴を入口で乾かしています。 | I am drying my wet shoes by the entrance.
夜になっても蒸し暑さが残りました。 | It remained hot and humid even after nightfall.
''',
    'conversation': '''
ありがとうございます。 | Thank you.
おはようございます。 | Good morning.
少々お待ちください。 | Please wait a moment.
はい、承知しました。 | Yes, I understand.
いいえ、それは違います。 | No, that is not correct.
もう一度お願いします。 | Could you say that again?
お会いできてうれしいです。 | I am glad to meet you.
それは残念でしたね。 | That is unfortunate.
私も同じことを考えていました。 | I was thinking the same thing.
詳しく聞かせてもらえますか。 | Could you tell me more about it?
途中で話を止めてしまってすみません。 | Sorry for interrupting you.
今の説明でよくわかりました。 | Your explanation made it clear.
別の言い方で説明してみます。 | I will try explaining it another way.
無理に今決めなくても大丈夫です。 | You do not have to decide right now.
その話の続きを楽しみにしています。 | I look forward to hearing the rest of that story.
どうぞお先に進んでください。 | Please go ahead.
必要なら私が手伝います。 | I can help if you need me.
ここまでの内容を確認しましょう。 | Let us review what we have covered so far.
今は返事を待っているところです。 | I am waiting for a reply at the moment.
また明日お話ししましょう。 | Let us talk again tomorrow.
''',
}

CALIBRATION = {
    'music': '''
演奏が始まる前に客席が静かになりました。 | The audience grew quiet before the performance began.
低い音が床から響いてくるように感じます。 | The low notes feel as though they are resonating through the floor.
歌詞を見ずに最後まで歌えました。 | I sang to the end without looking at the lyrics.
何度も練習した部分で間違えてしまいました。 | I made a mistake in the part I had practiced repeatedly.
隣の人の拍手につられて私も手をたたきました。 | I started clapping along with the person next to me.
この曲を聞くと昔のことを思い出します。 | This song reminds me of the past.
楽器をケースに戻してから片づけます。 | I put the instrument back in its case before tidying up.
メロディーは覚えていますが曲名が出てきません。 | I remember the melody, but I cannot recall the title.
伴奏の音量を少し抑えてもらいました。 | I asked for the accompaniment to be a little quieter.
最後の音が消えるまで誰も動きませんでした。 | Nobody moved until the last note faded away.
''',
    'sports': '''
試合の開始が十五分遅れました。 | The start of the match was delayed by fifteen minutes.
観客席から選手の名前を呼びました。 | I called out the player's name from the stands.
練習の前に道具の状態を確かめます。 | I check the equipment before practice.
ボールが思ったより遠くへ飛びました。 | The ball traveled farther than I expected.
今日は勝敗よりも動き方を覚えたいです。 | Today I want to learn the movements rather than focus on winning.
最後の一周だけ少し速く走りました。 | I ran a little faster only on the final lap.
一緒に練習する相手が見つかりました。 | I found someone to practice with.
応援していたチームが逆転しました。 | The team I was supporting came from behind to take the lead.
審判の笛が鳴って試合が止まりました。 | The referee's whistle sounded, and the game stopped.
道具を借りた人へ返すのを忘れないでください。 | Please remember to return the equipment to the person you borrowed it from.
''',
}

EVALUATION = {
    'books': '''
小説の結末を知るまでは感想を読まないことにしています。 | I avoid reading reviews until I know how the novel ends.
栞を挟んだはずなのに、読む場所を見失いました。 | I lost my place even though I thought I had inserted a bookmark.
図書館の返却箱は閉館後も使えるそうです。 | Apparently, the library's return box can be used after closing time.
表紙の絵から想像した内容とはかなり違っていました。 | The contents were quite different from what the cover illustration led me to expect.
章ごとに語り手が変わるので注意して読みました。 | I read carefully because the narrator changes from chapter to chapter.
古本の間に昔の乗車券が挟まっていました。 | An old train ticket was tucked between the pages of the used book.
続編が出るまで最初の巻を読み直すつもりです。 | I plan to reread the first volume while waiting for the sequel.
書店の店員が探していた本を奥から持ってきてくれました。 | The bookseller brought the book I was looking for from the back of the shop.
短い物語なのに登場人物が強く印象に残りました。 | Despite the story being short, its characters left a strong impression on me.
本の題名を控えておけばよかったと後悔しました。 | I regretted not making a note of the book's title.
''',
    'animals': '''
犬が眠っている間に首輪をそっと外しました。 | I gently removed the dog's collar while it was asleep.
水槽の魚は餌を入れるとすぐに集まってきます。 | The fish in the tank gather immediately when food is added.
猫は新しい寝床より空き箱を気に入ったようです。 | The cat seems to prefer the empty box to its new bed.
庭の鳥が飛び立つ瞬間を窓から見ていました。 | I watched from the window as a bird in the garden took flight.
散歩中の子犬が落ち葉を追いかけていました。 | The puppy was chasing fallen leaves during its walk.
動物の足跡が砂の上に並んで残っています。 | A row of animal footprints remains in the sand.
名前を呼ぶと耳だけこちらへ向けました。 | When I called its name, it turned only its ears toward me.
いつも隠れている亀が今日は岩の上にいました。 | The turtle that usually hides was on top of a rock today.
餌の袋を開ける音にすぐ気づいたようでした。 | It seemed to notice the sound of the food bag opening right away.
柵の向こうで馬がゆっくり草を食べていました。 | A horse was slowly grazing beyond the fence.
''',
    'photography': '''
逆光だったので人物の顔が暗く写りました。 | The person's face came out dark because the light was behind them.
写真を拡大して初めて小さな傷に気づきました。 | I noticed the tiny scratch only after enlarging the photograph.
シャッターを押した瞬間に相手が目を閉じました。 | The other person closed their eyes just as I pressed the shutter.
同じ景色でも撮る高さによって印象が変わります。 | Even the same view looks different depending on the height from which it is photographed.
旅行の写真を撮影日順に並べ直しました。 | I rearranged the travel photographs by the date they were taken.
手ぶれを避けるためにカメラを台に載せました。 | I placed the camera on a stand to avoid shaking it.
写真の端に知らない人が写り込んでいました。 | An unfamiliar person appeared at the edge of the photograph.
明るさを調整しすぎて空の色が不自然になりました。 | I adjusted the brightness too much, making the sky look unnatural.
印刷した写真の裏に撮影場所を書きました。 | I wrote the location on the back of the printed photograph.
レンズを替える間はカメラを下に向けています。 | I point the camera downward while changing the lens.
''',
    'museum': '''
展示の説明文を読むと作品の見方が変わりました。 | Reading the exhibition text changed how I saw the artwork.
館内では撮影できる場所が限られています。 | Photography is allowed only in certain areas of the building.
入口で受け取った案内図を折ってポケットに入れました。 | I folded the map I received at the entrance and put it in my pocket.
展示室の順路に沿って進むと中庭へ出ました。 | Following the route through the galleries led me to a courtyard.
古い地図には今とは違う地名が書かれていました。 | The old map showed place names different from those used today.
音声案内を止めてもう一度実物を眺めました。 | I paused the audio guide and looked at the actual object again.
子供が模型の細かな部分を熱心に見ていました。 | A child was studying the small details of the model intently.
展示替えのため一部の部屋が閉まっていました。 | Some rooms were closed while the displays were being changed.
出口の売店で展示に関連した葉書を選びました。 | I chose a postcard related to the exhibition at the shop by the exit.
遠くから見ると別の形に見える彫刻がありました。 | There was a sculpture that looked like a different shape from a distance.
''',
    'crafts': '''
糸を短く切りすぎて結び目を作れませんでした。 | I cut the thread too short to tie a knot.
絵の具が乾いてから次の色を重ねました。 | I added the next color after the paint had dried.
紙の裏側から線をなぞると折り目がつけやすくなります。 | Tracing the line from the back of the paper makes it easier to crease.
針を使い終えたら専用の箱へ戻します。 | I return the needle to its designated box after using it.
完成した作品を机に並べて比べました。 | I laid the finished pieces on the table and compared them.
型紙を布に留めるときに位置がずれてしまいました。 | The pattern shifted when I pinned it to the fabric.
陶器の縁に残った凹凸を指で確かめました。 | I felt the unevenness left on the pottery's rim with my finger.
小さな部品をなくさないよう皿の上に置きました。 | I placed the small parts on a plate so I would not lose them.
色の組み合わせを考えるところが一番楽しいです。 | Thinking about color combinations is the part I enjoy most.
最初の失敗を手がかりに作り方を変えてみました。 | I changed the method based on what went wrong in my first attempt.
''',
    'science': '''
実験の前後で容器の重さを量りました。 | We weighed the container before and after the experiment.
観察した変化を時刻と一緒に記録します。 | We record the changes we observe together with the time.
同じ条件でも毎回少し違う結果になりました。 | The results varied slightly each time even under the same conditions.
目盛りを真横から読むように言われました。 | I was told to read the scale from directly beside it.
説明と実際の結果が違う理由を話し合いました。 | We discussed why the actual results differed from the explanation.
手順を一つ飛ばしていたことが後でわかりました。 | We later realized that we had skipped a step.
測定した値を表にしてから比較しました。 | We put the measured values into a table before comparing them.
透明な液体の中に小さな粒が浮いていました。 | Small particles were floating in the clear liquid.
器具についた番号と記録用紙の番号を照合します。 | We match the numbers on the instruments with those on the record sheet.
予想に反した結果もそのまま残しておきました。 | We kept the results as they were even when they contradicted our prediction.
''',
    'clothing': '''
試着した上着は肩の部分だけ窮屈でした。 | The jacket I tried on was tight only around the shoulders.
同じサイズでも生地によって着心地が違います。 | Even at the same size, different fabrics feel different to wear.
袖を折り返すと手首がちょうど出ます。 | Folding back the sleeves exposes my wrists just enough.
洗濯表示を見てから洗い方を決めました。 | I checked the care label before deciding how to wash it.
去年の靴がまだ履けるか確かめていました。 | I was checking whether I could still wear last year's shoes.
ボタンの色だけを替えると印象が変わりました。 | Changing only the button color gave it a different look.
店の照明と外の光では色が違って見えます。 | The color looks different under the shop lights and in daylight.
薄い服を重ねて気温の変化に備えました。 | I wore layers of light clothing to prepare for temperature changes.
新しい鞄には内側にも小さなポケットがあります。 | The new bag has a small pocket on the inside as well.
ほつれた裾を直してもう少し使うつもりです。 | I intend to repair the frayed hem and keep using it a little longer.
''',
    'delivery': '''
荷物を受け取ったときに箱の角がへこんでいました。 | A corner of the box was dented when I received the package.
伝票の住所が途中で切れて印刷されていました。 | The address on the shipping label was cut off in the printout.
届け先の名前を間違えて入力してしまいました。 | I accidentally entered the wrong recipient's name.
不在票に書かれた番号で再配達を申し込みました。 | I arranged redelivery using the number on the delivery notice.
割れやすい物なので箱の中を紙で埋めました。 | I filled the box with paper because the contents were fragile.
受け取りの時間帯を午前から夕方に変えました。 | I changed the delivery window from morning to evening.
封筒の口が開かないようにテープを貼りました。 | I taped the envelope shut so it would not open.
追跡番号を検索すると途中の場所が表示されました。 | Looking up the tracking number showed an intermediate location.
送った相手から無事に届いたと連絡がありました。 | The recipient let me know that what I sent had arrived safely.
箱を開ける前に送り主を確かめました。 | I checked who had sent the box before opening it.
''',
    'plants': '''
鉢を動かしたら下に小さな根が出ていました。 | When I moved the pot, I found small roots growing underneath it.
葉の裏にも水滴が残っていました。 | There were still water droplets on the undersides of the leaves.
伸びた枝が隣の鉢に触れるようになりました。 | The growing branch has started touching the neighboring pot.
新しい芽がどこから出るか毎朝見ています。 | I check every morning to see where new shoots will appear.
花が咲いた日を札に書いて鉢に付けました。 | I wrote the date the flower bloomed on a tag and attached it to the pot.
倒れた茎を細い支柱に軽く結びました。 | I loosely tied the fallen stem to a thin support.
窓辺に並べた鉢の向きを少しずつ変えています。 | I turn the pots lined up by the window a little at a time.
土がこぼれたので新聞紙を下に敷きました。 | I spread newspaper underneath because soil had spilled.
去年植えた場所を忘れないよう印を付けました。 | I marked the spot where I planted it last year so I would not forget.
枯れたと思っていた枝に芽を見つけました。 | I found a bud on a branch I had thought was dead.
''',
    'events': '''
受付で名札を受け取って胸に付けました。 | I received a name badge at reception and pinned it to my chest.
開始を知らせる放送が会場に流れました。 | An announcement that the event was starting played through the venue.
案内された席にはすでに別の人が座っていました。 | Someone else was already sitting in the seat I was shown.
休憩の間に展示された資料を見て回りました。 | I looked around at the displayed materials during the break.
予定していた屋外の催しは屋内へ移されました。 | The planned outdoor activity was moved indoors.
質問するために手を挙げましたが時間が足りませんでした。 | I raised my hand to ask a question, but there was not enough time.
帰り際に主催者へお礼を伝えました。 | I thanked the organizer as I was leaving.
隣に座った人と偶然同じ場所の出身でした。 | By chance, the person sitting next to me came from the same place as I did.
参加者がそろうまで入口で待機していました。 | We waited at the entrance until all the participants had gathered.
片づけを手伝ってから会場を後にしました。 | I helped clean up before leaving the venue.
''',
}

# Predeclared supplemental probes, never used for fitting or calibration.
# Empty/symbol-only/URL-only inputs have no defensible Japanese/English gold.
PROBES = [
    ('short-ja', 'はい。', 'ja'), ('short-en', 'Yes.', 'en'),
    ('thanks-ja', 'ありがとう', 'ja'), ('hello-en', 'Hello!', 'en'),
    ('hiragana', 'きょうはのんびりすごしたいです。', 'ja'),
    ('katakana', 'コノメッセージハニホンゴデス。', 'ja'),
    ('romaji-ja', 'Kyou wa ie de yasumimasu.', 'ja'),
    ('romaji-greeting', 'Ohayou gozaimasu.', 'ja'),
    ('en-lowercase', 'please keep the window open', 'en'),
    ('en-uppercase', 'PLEASE READ THE NOTICE CAREFULLY.', 'en'),
    ('ascii-product-ja', 'CPUとGPUの設定をGitHubで確認します。', 'ja'),
    ('decimal-ja', '価格は1,250円で、重さは3.14kgです。', 'ja'),
    ('decimal-en', 'It costs $1,250 and weighs 3.14 kg.', 'en'),
    ('quote-en-in-ja', '設定画面で Keep me signed in を選んでください。', 'ja'),
    ('quote-ja-in-en', 'Select 「設定」 and then click the blue button.', 'en'),
    ('url-ja', '詳しくはhttps://example.org/v2.5を見てください。', 'ja'),
    ('url-en', 'For details, visit https://example.org/v2.5.', 'en'),
    ('abbrev-en', 'Dr. Adams works at the U.S. office.', 'en'),
    ('quoted-title', 'The sign reads 「入口」, which means entrance.', 'en'),
    ('prefix-ja', '明日の予定についてはまだ', 'ja'),
    ('prefix-en', 'The reason we postponed the', 'en'),
    ('emoji-ja', 'この写真はお気に入りです😊', 'ja'),
    ('emoji-en', 'That was a wonderful surprise 😊', 'en'),
    ('empty', '', None), ('digits', '12345', None),
    ('symbols', '...!?', None), ('bare-url', 'https://example.org', None),
    ('balanced-mixed', '今日は休みです。Tomorrow I will work.', None),
]


def rows():
    result = []
    for split, groups in [('train', TRAIN), ('calibration', CALIBRATION), ('evaluation', EVALUATION)]:
        for group, source in groups.items():
            pairs = [line.strip().split(' | ') for line in source.strip().splitlines()]
            for index, pair in enumerate(pairs):
                if len(pair) != 2:
                    raise ValueError('invalid bilingual pair')
                conversation = f'{group}-{index + 1:02d}'
                for language, text in zip(['ja', 'en'], pair):
                    result.append(dict(id=f'{split}-{conversation}-{language}', split=split,
                                       conversation_id=conversation, template_group=group,
                                       language=language, text=text, synthetic=True))
    return result


def validate(data):
    counts = {}
    ids, texts = set(), set()
    partitions = {'conversation_id': {}, 'template_group': {}}
    for row in data:
        if row['id'] in ids or row['text'] in texts:
            raise ValueError('duplicate ID or text')
        ids.add(row['id'])
        texts.add(row['text'])
        if row['language'] not in ['ja', 'en'] or row['split'] not in ['train', 'calibration', 'evaluation'] or not row['text'].strip():
            raise ValueError('invalid example')
        for field, mapping in partitions.items():
            value = row[field]
            if value in mapping and mapping[value] != row['split']:
                raise ValueError('conversation/template crosses partitions')
            mapping[value] = row['split']
        key = row['split'] + '-' + row['language']
        counts[key] = counts.get(key, 0) + 1
    expected = {f'{split}-{language}': count for split, count in [('train', 200), ('calibration', 20), ('evaluation', 100)] for language in ['ja', 'en']}
    if counts != expected:
        raise ValueError(f'expected exact per-language counts {expected}, got {counts}')
    return counts


if __name__ == '__main__':
    data = rows()
    validate(data)
    # Source training/evaluation text is intentional repository content, not a run log.
    Path(__file__).with_name('examples.jsonl').write_text(''.join(json.dumps(r, ensure_ascii=False) + '\n' for r in data))
