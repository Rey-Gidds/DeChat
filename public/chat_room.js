const user = io('https://dechat-o5h4.onrender.com')
const sendbtn = document.getElementById('sendbtn')
const room_title = document.getElementById('room_title')
const keyBtn = document.getElementById('createKey')
const receiveSound = new Audio('receive.wav')
const leaveSound = new Audio('newJoin1.wav')
const delSound = new Audio('Remove_Msg.flac')
const fileInput = document.getElementById('fileInput')
let sending_indicator = document.getElementById('sending-indicator')
let chatBox = document.getElementById('chatBox')
let notificationBtn = document.getElementById('notify')
let display_room_title = document.getElementById('display_room_title')
let replyPreviewContainer = document.getElementById('replyPreviewContainer')
let message = document.getElementById('message')
let imageContainer = document.getElementById('imageContainer')
let memberColorBalls = document.getElementById('memberColorBalls')
let displayRoomKey = document.getElementById('displayRoomKey')

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
let notification;
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
let isCreate = JSON.parse(localStorage.getItem("isCreate")) || false
let msg_to_edit_index = null
let count = 0

display_room_title.style.display = 'none'
document.addEventListener("visibilitychange" , () => {
    if(document.visibilityState === "visible"){
        user.connect()
    }
})

if(!isCreate){
    console.log("Joining Room")
    let createArea = document.getElementById("createRoomArea")
    key = JSON.parse(localStorage.getItem("roomKey")) || null
    console.log(key)
    createArea.style.display = "none"
    if(key) {
        joinRoom()
    }
}


user.on('TakeUserId' , (userId) => {
    if(user_id == ''){
        user_id = userId
    }
    console.log('User ID: ' , user_id)
})


Notification.requestPermission()


document.addEventListener('visibilitychange' , () => {
    if(document.visibilityState === "hidden"){
        notify = true
        notification = new Notification("Trying to hide the chats huh ? 🥷" , { silent: true })
    } else {
        count = 0
        notify = false
        notification.close()
    }
})


// Function to generate the random key , 11 characters in length
keyBtn.addEventListener('click' , (e) => {
    key = ''
    if(room_title.value === '' || room_title.value.length < 4){
        alert("Room Title too short.")
        return
    }
    else if(isJoined){
        alert("Seems like you're already joined in a room , Refresh the page to join another room.")
        return
    }
    let chars = 'ABCDEFGHIJKL0123456789MNOPQRST@$&_UVWXYZ'
    let nums = ''
    for(let i = 0 ; i<11 ; i++){
        let index = Math.floor(Math.random()*chars.length)
        key += chars[index]
    }
    console.log(key)
    joinRoom()
    isJoined = true
    displayRoomKey.innerText = `Joined Room: ${key}`
    scrollToBottomWindow()
})


function joinRoom(){
    if(isJoined){
        alert("Seems like you're already joined in a room , Refresh the page to join another room.")
        return
    }
    else if(displayRoomKey.innerText === '' && key) displayRoomKey.innerText = `Joined Room: ${key}`
    user.emit('joinRoom' , key , room_title.value)
    user.emit('get_room_title')
    isJoined = true
}

user.on('take_room_title' , (room_title) => {
    display_room_title.style.display = 'block'
    display_room_title.textContent = room_title
})

fileInput.addEventListener('change' , () => {
    isFile = true
    let file = fileInput.files[0]
    let fileSize = (file.size/1024)
    if(fileSize > 350){
        replyPreviewContainer.innerHTML = `Too large file ! ,<br>
        currently we only support file upto 350 KB. <button class='cancelReplyBtn' onclick=cancelReply()><i class="fa-solid fa-xmark"></i></button>`
        cancelImg()
        return
    }
    if(file && file.type.startsWith("image/")){
        let reader = new FileReader()
        reader.readAsDataURL(file)
        reader.onload = () => {

            imageContainer.innerHTML = `<img src='${reader.result}' />
            <button onclick=cancelImg() id='cancelImgBtn'><i class="fa-solid fa-xmark"></button>`
            fileData = reader.result
            fileType = file.type
            scrollToBottomWindow()

        }
    }
    else{
        replyPreviewContainer.innerHTML = `We only support IMAGES for now. <button class='cancelReplyBtn' onclick=cancelReply()><i class="fa-solid fa-xmark"></i></button>`
        cancelImg()
    }
})

function scrollToBottomWindow(){
    window.scrollTo({top: document.body.scrollHeight + 200 , behavior: "smooth"})
}

function cancelImg(){
    isFile = false
    imageContainer.innerHTML = ''
    fileInput.value = ''
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
    scrollToBottomChatBox()
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
    if(!isJoined){
        alert("Seems like you're not joined in any room :(")
        return
    }
    if(isFile){
        user.emit('sendFile' , fileData , fileType)
        sending_indicator.innerHTML = '<div class="sending-bar"></div>'
        console.log('sending the file... ' , fileData ,fileType)
        cancelImg()
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
    message.value = '' 
})


function stringify_message(value){

/* 
    dummy value is taken to "not" directly stringify the original message value as the original value is
    passed to the backend and also to render msgs which should not be "stringified"
    hence the dummy value helps in passing the string as an argument in some functions in the program
    which include: reply() , editMsg() in which the msg with new lines cannot be passed directly as 
    an argument 
*/
    let dummy_value = value;
    return JSON.stringify(dummy_value)
}

let scrollTimeout;
chatBox.addEventListener('scroll' , () => {
    isScrolling = true

    clearTimeout(scrollTimeout)

    scrollTimeout = setTimeout(() => {
        isScrolling = false
    } , 800)
})


user.on('message', ({ msg, userColor }, sender, msg_index, file_flag , replying_flag , rmsg , rcolor) => {

    let msgContainer = document.createElement('div'); // Main container
    msgContainer.className = 'msgBubble';
    msgContainer.style.color = userColor;
    msgContainer.id = msg_index;
    render_msg({ msg, userColor }, sender, msg_index, file_flag , replying_flag , rmsg , rcolor,msgContainer,false)

    chatBox.appendChild(msgContainer); // Append entire bubble to chatBox

    if (chatBox.contains(typingBubble)) {
        chatBox.appendChild(typingBubble);
    }

    if(!isScrolling){
        scrollToBottomChatBox()
    }

});

user.on('receiveFile' , (sender , file_data , file_type , userColor , msg_index) => {
    sending_indicator.innerHTML = ''
    let typingBubble = document.getElementById('typingBalls')
    let msgContainer = document.createElement('div') // Main container
    msgContainer.className = 'msgBubble'
    msgContainer.id = msg_index
    msgContainer.style.border = `3px dashed ${userColor}`

    let newMsg = document.createElement('p');
    newMsg.className = 'messageContent';
    newMsg.id = `content_${msg_index}`
    

    if(sender == user_id){
        msgContainer.style.borderRadius = '20px 20px 2px 20px'
        msgContainer.style.width = 'fit-content'
        msgContainer.style.alignSelf = 'flex-end'
        newMsg.innerHTML = `<img src=${file_data} class='chat-img' onclick=openImageWindow("${file_data}") />
        <button class='DelBtns' data-value='${msg_index}' onclick='removeMsg(${msg_index})'>
            <i class="fa-solid fa-trash"></i>
        </button>`
    }
    else{
        msgContainer.style.borderRadius = '20px 20px 20px 2px'
        msgContainer.style.width = 'fit-content'
        msgContainer.style.alignSelf = 'flex-start'
        newMsg.innerHTML = `<img src=${file_data} class='chat-img' onclick=openImageWindow("${file_data}") />
        <button class='replyBtnImg' onclick='replyFile("${file_data}", "${userColor}")'>
            <i class="fa-solid fa-reply"></i>
        </button>`
        messageNotification()
        receiveSound.play()
    }

    msgContainer.appendChild(newMsg)
    chatBox.appendChild(msgContainer)
    if (chatBox.contains(typingBubble)) {
        chatBox.appendChild(typingBubble);
    }
    scrollToBottomChatBox()
})


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

function replyFile(file_data , color){
    isReplying = true
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
    user.emit('update_reply_flag' , true , true , file_data , color)
    scrollToBottomWindow()
}


function reply(msg , color){
    isReplying = true
    replyPreviewContainer.innerHTML = ''
    let replyPreview = document.createElement('div')
    replyPreview.className = 'replyPreview'

    // innerHTML always ignores the \n characters , that is why the JSON stringified string passed as the
    //  string argument has \n characters , but the innerHTML "IGNORES" it
    replyPreview.innerHTML = `Replying to: ${msg} <button class='cancelReplyBtn' onclick=cancelReply()><i class="fa-solid fa-xmark"></i></button>`
    replyPreview.style.color = color
    replyPreviewContainer.appendChild(replyPreview)
    console.log('before sending to backend: ' , msg , color)
    user.emit('update_reply_flag' , false , true , msg , color)
    scrollToBottomWindow()
    return;
}

function cancelReply(){
    isReplying = false
    replyPreviewContainer.innerHTML = ''
    user.emit('update_reply_flag' , false , false , '' , '')
}


user.on('msgEdited' , ({ msg , userColor } , sender , msg_index_for_edit , replying_flag_file , replying_flag , rmsg , rcolor) => {
    
    let editedMsgContainer = document.getElementById(`content_${msg_index_for_edit}`)
    editedMsgContainer.innerHTML = ''

    render_msg({ msg , userColor } , sender , msg_index_for_edit , replying_flag_file , replying_flag , rmsg , rcolor , editedMsgContainer , true)
})

function messageNotification(){
    if(!notify) return
    count++
    new Notification(`${count} new message` , {
        tag: 'message_notification',
        vibrate: [100 , 100]
    })
}

function render_msg({msg , userColor} , sender , msg_index , flag_file , flag_reply , rmsg , rcolor , msgContainer , editing_msg){

    if(flag_file){
        let replyMsg = document.createElement('div');
        replyMsg.className = 'replyMsg';
        replyMsg.style.border = `2px dashed ${rcolor}`;
        replyMsg.innerHTML = `
            <img src=${rmsg} class='replyImg' onclick=openImageWindow("${rmsg}")/>
            <button class='replyBtnImg' onclick=replyFile("${rmsg}" , "${rcolor}")>
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
        
        if(isReplying){
            cancelReply()
        } 

        if(!editing_msg){
            msgContainer.style.borderRadius = '20px 20px 2px 20px'
            msgContainer.style.width = '70%'
            msgContainer.style.alignSelf = 'flex-end'
        }
        new_msg.innerHTML += `
            <div class='msgBtnContainer'>
                <button class='EditBtn' data-value='${msg_index}' onclick='editMsg(${msg_index}, ${stringify_message(msg)} , "${userColor}")'>
                    <i class="fa-solid fa-pencil"></i>
                </button>
                <button class='DelBtns' data-value='${msg_index}' onclick='removeMsg(${msg_index})'>
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
            <button class='replyBtn' data-message=${stringify_message(msg)} data-color="${userColor}" >
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
    let button = e.target;
    if(button.className === 'replyBtn'){
        let msg = button.getAttribute('data-message');
        let color = button.getAttribute('data-color');
        reply(msg , color);
        return;
    }
    return;
})

function editMsg(edit_index , msg , color){
    isEdit = true
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
    message.value = ''
    msg_to_edit_index = null
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
    displayRoomKey.innerText = msg
})

user.on('disconnected' , () => {
    message.value = ''
    displayRoomKey.value = ''
    memberColorBalls.value = ''
    chatBox.innerHTML = ''
})