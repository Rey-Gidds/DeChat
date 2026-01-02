const user = io('https://dechat-o5h4.onrender.com')
const sendbtn = document.getElementById('sendbtn')
const room_title = JSON.parse(localStorage.getItem('room_title'))
const keyBtn = document.getElementById('createKey')
const receiveSound = new Audio('receive.wav')
const leaveSound = new Audio('newJoin1.wav')
const delSound = new Audio('Remove_Msg.flac')
const fileInput = document.getElementById('fileInput')
let image_sending_indicator = document.getElementById('sending-indicator')
let loading_container = document.getElementById('loading_container')
let chatBox = document.getElementById('chatBox')
let display_room_title = document.getElementById('display_room_title')
let replyPreviewContainer = document.getElementById('replyPreviewContainer')
let message = document.getElementById('message')
let imageContainer = document.getElementById('imageContainer')
let memberColorBalls = document.getElementById('memberColorBalls')
let displayRoomKey = document.getElementById('displayRoomKey')
let max_connections = JSON.parse(localStorage.getItem('max_connections'));
let room_header = document.getElementById('room_header')


clearImagePreview();
remove_chat_elements();
clearImageSendingIndicator();
clearReplyPreview();


// Varibles to store critical information at the frontend 
/*  Note:
        Any variable changed from this below section may break the code , 
        as it contains necessary booleans and certain information user specific that is 
        stored at the frontend , Hence , handle the below variables with care ;) ,this information includes :
        1. The key of the room
        2. HASHED user id provided by the socket.io framework , which is stored at the frontend for
            for some features
        3. file data being sent 
        4. type of the file being sent
*/
let key = ''
let user_id = ''
let fileData = ''
let fileType = ''
let isEdit = false
let isJoined = false
let isScrolling = false
let notify = false
let isFile = false
let isReplying = false
const YES_FILE = true
const NO_FILE = false
const FLAG = true
let isCreate = JSON.parse(localStorage.getItem("isCreate")) || false
let msg_to_edit_index = null
let count = 0
let imageChunks = [];
let display_file_data = ''



if(!isCreate){
    key = JSON.parse(localStorage.getItem("roomKey")) || null
    if(key) {
        joinRoom()
    }
    else{
        room_header.innerHTML = 'Unable to connect to the room :( , <a href="doors.html"> Back to Doors </a>'
    }
}
else{
    key = JSON.parse(localStorage.getItem('Key')) || null
    if(key) {
        joinRoom()
    }
    else{
        room_header.innerHTML = 'Unable to connect to the room :( , <a href="doors.html"> Back to Doors </a>'
    }
}

function remove_chat_elements(){
    room_header.style.display = 'none';
    chatBox.style.display = 'none';
    display_room_title.style.display = 'none';
    document.querySelector('.sendArea').style.display = 'none';
    memberColorBalls.style.display = 'none';
}

function display_chat_elements(){
    room_header.style.display = 'flex';
    chatBox.style.display = 'flex';
    display_room_title.style.display = 'flex';
    document.querySelector('.sendArea').style.display = 'flex';
    memberColorBalls.style.display = 'flex';
}

function displayLoading(){
    loading_container.style.display = 'flex';
}

function removeLoading(){
    loading_container.style.display = 'none';
}

user.on('TakeUserId' , (userId) => {
    if(user_id == ''){
        user_id = userId
    }
})


function joinRoom(){
    if(isJoined){
        alert("Seems like you're already joined in a room , Refresh the page to join another room.");
        return;
    }
    remove_chat_elements();
    displayLoading();
    user.emit('joinRoom' , key , room_title , max_connections);
    user.emit('get_room_title');
    isJoined = true;
}

user.on('take_room_title' , (room_title) => {
    removeLoading();
    display_room_title.style.display = 'block';
    display_room_title.textContent = room_title;
    displayRoomKey.innerText = `Joined Room: ${key}`;
    display_chat_elements();
})

async function imagePreview(image) {
    fileData = image
    fileType = image.type
    const reader = new FileReader();
    reader.readAsDataURL(image);
    reader.onload = () => {
        imageContainer.innerHTML = `<img src='${reader.result}' />
        <button onclick=cancelImg() id='cancelImgBtn'><i class="fa-solid fa-xmark"></button>`
        scrollToBottomWindow()
    }
}

const CHUNK_SIZE = 64 * 1024; // 64KB

function updateImageSendingProgress(sentBytes, totalBytes) {
  const percentage = Math.min((sentBytes / totalBytes) * 100, 100);
  image_sending_indicator.innerHTML = `${percentage.toFixed(2)}%`;
}

async function sendImage(user, file) {
  let offset = 0;

  while (offset < file.size) {
    const chunk = file.slice(offset, offset + CHUNK_SIZE);
    const buffer = await chunk.arrayBuffer(); // async, non-blocking
    user.emit("upload-chunk", buffer);
    offset += CHUNK_SIZE;
    updateImageSendingProgress(offset, file.size);
  }

  user.emit("image-end");
}


fileInput.addEventListener('change' , () => {
    isFile = true
    let file = fileInput.files[0]
    imageContainer.style.display = 'flex';
    if(file && file.type.startsWith("image/")){
        imagePreview(file);
    }
})


user.on("image-chunk", (chunk) => {
    imageChunks.push(chunk); // chunk = ArrayBuffer / Uint8Array
});


function scrollToBottomWindow(){
    window.scrollTo({top: document.body.scrollHeight + 200 , behavior: "smooth"})
}

function cancelImg(){
    isFile = false
    clearImagePreview();
    fileInput.value = ''
}


function clearReplyPreview(){
    replyPreviewContainer.innerHTML = '';
    replyPreviewContainer.style.display = 'none';
}

function clearImagePreview(){
    imageContainer.innerHTML = '';
    imageContainer.style.display = 'none';
}

function clearImageSendingIndicator(){
    image_sending_indicator.innerHTML = '';
    image_sending_indicator.style.display = 'none';
}


let typingTimeout;
message.addEventListener('focus' , () => {
    clearTimeout(typingTimeout)
    setTimeout(() => {
        user.emit('typing')
    } , 100)
})

message.addEventListener('blur' , () => {
    typingTimeout = setTimeout(() => {
        user.emit('stoppedTyping')
    } , 200)
})


user.on('addtypingball' , (userColor , isBubble) => {
    if(!isBubble){
        let typingBubble = createTypingBubbleElement()
        chatBox.appendChild(typingBubble)
    }
    else{
        typingBubble = document.getElementById('typingBalls')
    }
    let ball = document.createElement('div')
    ball.setAttribute('class' , 'typingBall')
    ball.setAttribute('id' , `typing_ball_${userColor}`)
    ball.style.backgroundColor = userColor
    typingBubble.appendChild(ball)
})

function createTypingBubbleElement(){
    typingBubble = document.createElement('div')
    typingBubble.setAttribute('id' , 'typingBalls')
    return typingBubble
}

user.on('removetypingBall' , (userColor) => {
    let removeBall = document.getElementById(`typing_ball_${userColor}`)
    let typingBubble = document.getElementById('typingBalls')
    if(removeBall){
        removeBall.remove()
    }
    if(typingBubble && typingBubble.innerHTML === ''){
        typingBubble.remove()
        user.emit('updateBubbleFlag' , false)
    }
})


sendbtn.addEventListener('click' , (e) => {
    if(isFile){
        sendImage(user , fileData)
        // image_sending_indicator.style.display = 'flex';
        // image_sending_indicator.innerHTML = '<div class="sending-bar"></div>'
        clearReplyPreview();
        cancelImg();
        return
    }
    else if(message.value.trim() === ''){
        return
    }
    else if(isEdit){
        user.emit('editMsg' , msg_to_edit_index , message.value.trim())
        message.value = ''
        cancelEdit()
        return
    }
    user.emit('send_message' , message.value.trim())
    if(isReplying) cancelReply();
    message.value = '' 
})


function stringify_message(value){

/* 
    dummy value is taken to "not" directly stringify the original message value as the original value is
    passed to the backend and also to render msgs which should not be "stringified"
    hence the dummy value helps in passing the string as an argument in some functions in the program
    which include: replyTextPreview() , editMsg() in which the msg with new lines cannot be passed directly as 
    an argument 
*/
    
    let dummy_value = value;
    return JSON.stringify(dummy_value);
}

let scrollTimeout;
chatBox.addEventListener('scroll' , () => {
    isScrolling = true

    clearTimeout(scrollTimeout)

    scrollTimeout = setTimeout(() => {
        isScrolling = false
    } , 800)
})

// { msg, userColor }, sender, msg_index, file_flag , replying_flag , rmsg , rcolor

user.on('message', (msg_object) => {
    let msgContainer = document.createElement('div'); // Main container
    let msg = String(msg_object.msg)
    let userColor = String(msg_object.userColor)
    let sender = String(msg_object.sender)
    let msg_index = parseInt(msg_object.msg_index)
    let file_flag = msg_object.file_flag
    let replying_flag = msg_object.flag
    let rmsg = String(msg_object.rmsg)
    let rcolor = String(msg_object.rcolor)
    let NOT_EDITING = false
    msgContainer.className = 'msgBubble';
    msgContainer.style.color = userColor;
    msgContainer.id = msg_index;

    render_msg(msg, userColor , sender, msg_index, file_flag , replying_flag , rmsg , rcolor, msgContainer , NOT_EDITING)

    chatBox.appendChild(msgContainer); // Append entire bubble to chatBox

    if(!isScrolling){
        scrollToBottomChatBox()
    }
    handleTypingBubble();
});

function construct_file_data(){
    const blob = new Blob(imageChunks, { type: "image/*" }); // or appropriate MIME type
    const url = URL.createObjectURL(blob);
    let file_data = url
    imageChunks = [];
    return file_data;
}

user.on('recieve_file' , (sender_obj) => {
    
    let sender = String(sender_obj.sender)
    let userColor = String(sender_obj.userColor)
    let msg_index = parseInt(sender_obj.msg_index)
    let file_data = construct_file_data()
    
    
    let msgContainer = document.createElement('div') // Main container
    msgContainer.className = 'msgBubble'
    msgContainer.id = msg_index
    msgContainer.style.border = `3px dashed ${userColor}`

    let newMsg = document.createElement('p');
    newMsg.className = 'messageContent';
    newMsg.id = `content_${msg_index}`
    

    if(sender == user_id){
        clearImageSendingIndicator();
        cancelImg();
        msgContainer.style.borderRadius = '20px 20px 2px 20px'
        msgContainer.style.width = 'fit-content'
        msgContainer.style.alignSelf = 'flex-end'
        newMsg.innerHTML = `<img src=${file_data} class='chat-img' onclick=openImageWindow("${file_data}") />
        <button class='DelBtns' data-value='${msg_index}'>
            <i class="fa-solid fa-trash"></i>
        </button>`
    }
    else{
        msgContainer.style.borderRadius = '20px 20px 20px 2px'
        msgContainer.style.width = 'fit-content'
        msgContainer.style.alignSelf = 'flex-start'
        newMsg.innerHTML = `<img src=${file_data} class='chat-img' onclick=openImageWindow("${file_data}") />
        <button class='replyBtnImg' onclick='replyFilePreview("${file_data}", "${userColor}")'>
            <i class="fa-solid fa-reply"></i>
        </button>`
        messageNotification()
        receiveSound.play()
    }

    msgContainer.appendChild(newMsg)
    chatBox.appendChild(msgContainer)

    handleTypingBubble()
    scrollToBottomChatBox()
})

function handleTypingBubble(){
    let typingBubble = document.getElementById('typingBalls')
    if (chatBox.contains(typingBubble)) {
        chatBox.appendChild(typingBubble);
    }
    return
}


function openImageWindow(data){
    setTimeout(() => {
        let imageWindow;
        imageWindow = window.open("" , "Image Window" , "_blank")
        if(imageWindow == null) return
        imageWindow.document.writeln(`
        <html>
            <head>
                <title>Image Viewer</title>
                <style>
                    body{
                        background-color: #444;
                        display: flex;
                        justify-content: center;
                        align-items: center;
                    }
                    .fullViewImage{
                        height: auto;
                        width: auto;
                        max-height: 80vh;
                        max-width: 80vw;
                        margin: auto;
                        border-radius: 10px;
                    }
                </style>
            </head>
            <body>
                <img src=${data} class='fullViewImage' />
            </body>
        </html>
        `)
    } , 350)
}

function scrollToBottomChatBox(){
    chatBox.scrollTo({top: chatBox.scrollHeight , behavior: "smooth"})
}

function replyFilePreview(file_data , color){
    isReplying = true
    replyPreviewContainer.style.display = 'flex';
    replyPreviewContainer.innerHTML = ''
    let replyPreview = document.createElement('div')
    replyPreview.className = 'replyPreview'
    replyPreview.innerHTML = `
        <img src=${file_data} class='replyImg' />
        <button class='cancelReplyBtn' onclick=cancelReply()>
            <i class="fa-solid fa-xmark"></i>
        </button>
    `
    replyPreview.style.border = `3px dashed ${color}`
    replyPreview.style.borderRadius = '10px'
    replyPreviewContainer.appendChild(replyPreview)
    user.emit('update_reply_flag' , YES_FILE , FLAG , file_data , color)
    scrollToBottomWindow()
}


function replyTextPreview(msg , color){
    isReplying = true
    replyPreviewContainer.style.display = 'flex';
    replyPreviewContainer.innerHTML = ''
    let replyPreview = document.createElement('div')
    replyPreview.className = 'replyPreview'

    // innerHTML always ignores the \n characters , that is why the JSON stringified string passed as the
    //  string argument has \n characters , but the innerHTML "IGNORES" it
    replyPreview.innerHTML = `Replying to: ${msg} <button class='cancelReplyBtn' onclick=cancelReply()><i class="fa-solid fa-xmark"></i></button>`
    replyPreview.style.color = color
    replyPreviewContainer.appendChild(replyPreview)
    console.log('before sending to backend: ' , msg , color)
    user.emit('update_reply_flag' , NO_FILE , FLAG , msg , color)
    scrollToBottomWindow()
    return;
}

function cancelReply(){
    isReplying = false
    clearReplyPreview();
    user.emit('update_reply_flag' , NO_FILE , !FLAG , '' , '')
}


user.on('msgEdited' , (msg_object) => {
    let msg = String(msg_object.msg)
    let userColor = String(msg_object.userColor)
    let sender = String(msg_object.sender)
    let msg_index = parseInt(msg_object.msg_index)
    let replying_flag_file = msg_object.file_flag
    let replying_flag = msg_object.flag
    let rmsg = String(msg_object.rmsg)
    let rcolor = String(msg_object.rcolor)
    let YES_EDITING = true
    let editedMsgContainer = document.getElementById(`content_${msg_index}`)
    
    editedMsgContainer.innerHTML = ''

    render_msg(msg , userColor  , sender , msg_index , replying_flag_file , replying_flag , rmsg , rcolor , editedMsgContainer , YES_EDITING)
})

function messageNotification(){
    if(!notify) return
    count++
    new Notification(`${count} new message` , {
        tag: 'message_notification',
        vibrate: [100 , 100]
    })
}

function render_msg(msg , userColor , sender , msg_index , flag_file , flag_reply , rmsg , rcolor , msgContainer , editing_msg){

    if(flag_file){
        let replyMsg = document.createElement('div');
        replyMsg.className = 'replyMsg';
        replyMsg.style.border = `2px dashed ${rcolor}`;
        replyMsg.innerHTML = `
            <img src=${rmsg} class='replyImg' onclick=openImageWindow("${rmsg}")/>
            <button class='replyBtnImg' onclick='replyFilePreview("${rmsg}" , "${rcolor}")'>
                <i class="fa-solid fa-reply"></i>
            </button>
        `;
        msgContainer.appendChild(replyMsg)
    }
    else if(flag_reply){
        let replyMsg = document.createElement('div');
        replyMsg.className = 'replyMsg';
        replyMsg.style.color = rcolor;
        replyMsg.innerHTML = `
            <span class="replyText">${rmsg}</span>
            <button class='replyBtn' data-message = ${stringify_message(rmsg)} data-color = "${rcolor}">
                <i class="fa-solid fa-reply"></i>
            </button>
        `;
        msgContainer.appendChild(replyMsg)
    }

    let new_msg;
    if(editing_msg){
        new_msg = document.getElementById(`content_${msg_index}`)
        new_msg.innerHTML = ''
    }
    else{
        new_msg = document.createElement('p')
        new_msg.className = 'messageContent'
        new_msg.id = `content_${msg_index}`
    }

    msgContainer.style.color = userColor

    new_msg.innerHTML = `<div>${msg}</div>`;
    if (sender == user_id) {
        if(!editing_msg){
            msgContainer.style.borderRadius = '20px 20px 2px 20px'
            msgContainer.style.width = '70%'
            msgContainer.style.alignSelf = 'flex-end'
        }
        new_msg.innerHTML += `
            <div class='msgBtnContainer'>
                <button class='EditBtn' data-value='${msg_index}' data-message = ${stringify_message(msg)} 
                data-color=${userColor} >
                    <i class="fa-solid fa-pencil"></i>
                </button>
                <button class='DelBtns' data-value='${msg_index}'>
                    <i class="fa-solid fa-trash"></i>
                </button>
            </div>
        `;
    } else {
        if(!editing_msg){
            msgContainer.style.borderRadius = '20px 20px 20px 2px'
            msgContainer.style.width = '70%'
            msgContainer.style.alignSelf = 'flex-start'
        }
        new_msg.innerHTML += `
            <button class='replyBtn' data-message = ${stringify_message(msg)} data-color="${userColor}">
                <i class="fa-solid fa-reply"></i>
            </button>
        `;
        messageNotification()
        receiveSound.play();
    }
    if(!editing_msg){
        msgContainer.appendChild(new_msg)
    }
    
    return
}


chatBox.addEventListener('click' , (e) => {
    const replyBtn = e.target.closest('.replyBtn');
    const editBtn = e.target.closest('.EditBtn');
    const delBtn = e.target.closest('.DelBtns');
    if (replyBtn) {
        let msg = replyBtn.getAttribute('data-message');
        let color = replyBtn.getAttribute('data-color');
        replyTextPreview(msg, color);
        return;
    }
    
    if (editBtn) {
        let msg_index = editBtn.getAttribute('data-value');
        let rmsg = editBtn.getAttribute('data-message');
        let rcolor = editBtn.getAttribute('data-color');
        editMsg(msg_index, rmsg, rcolor);
        return;
    }
    
    if (delBtn) {
        let msg_index = delBtn.getAttribute('data-value');
        removeMsg(msg_index);
        return;
    }
    return;
})

function editMsg(edit_index , msg , color){
    isEdit = true
    replyPreviewContainer.style.display = 'flex';
    replyPreviewContainer.innerHTML = ''
    let editPreview = document.createElement('div')
    editPreview.className = 'replyPreview'

    // innerHTML always ignores the \n characters , that is why the JSON stringified string passed as the
    //  string argument has \n characters , but the innerHTML "IGNORES" it
    editPreview.innerHTML = `Editing: ${msg} <button class='cancelReplyBtn' onclick=cancelEdit()><i class="fa-solid fa-xmark"></i></button>`
    editPreview.style.color = color
    replyPreviewContainer.appendChild(editPreview)
    scrollToBottomWindow()
    message.value = msg
    msg_to_edit_index = edit_index
}

function cancelEdit(){
    isEdit = false
    replyPreviewContainer.innerHTML = ''
    replyPreviewContainer.style.display = 'none';
    message.value = ''
    msg_to_edit_index = null
    clearReplyPreview();
}

function removeMsg(del_index){
    delSound.play()
    user.emit('deleteMsg' , del_index)
}

user.on('delfromChatBox' , (msgToDel) => {
    isFile = false
    let delmsg = document.getElementById(msgToDel)
    console.log('index returned from backend: ' , msgToDel)
    if(delmsg){
        delmsg.remove()
    }
})

user.on('userDisconnected' , () => {
    leaveSound.play()
})

user.on('addMemberBall' , (assignedColorsList) => {
    memberColorBalls.innerHTML = ''
    assignedColorsList.forEach((color) => {
        let ball = document.createElement('div')
        ball.setAttribute('class' , 'memberBall')
        ball.setAttribute('id' , color)
        ball.style.backgroundColor = color
        memberColorBalls.appendChild(ball)
    })
})


user.on('removeMemberColorBall' , (color) => {
    let memberColorBalls = document.getElementById('memberColorBalls')
    removeBall = document.getElementById(color)
    memberColorBalls.removeChild(removeBall)
})

user.on('RoomLimitReached' , (msg) => {
    removeLoading();
    displayRoomKey.innerText = msg
    let back_to_doors = document.createElement('a')
    back_to_doors.href = 'doors.html'
    back_to_doors.innerText = '    { Back To Doors }'
    back_to_doors.style.textDecoration = 'none'
    back_to_doors.style.fontSize = 'large'
    back_to_doors.style.marginTop = '10px'
    displayRoomKey.appendChild(back_to_doors)
    user.disconnect()
})

user.on('disconnected' , () => {
    message.value = ''
    displayRoomKey.value = ''
    memberColorBalls.value = ''
    chatBox.innerHTML = ''
})