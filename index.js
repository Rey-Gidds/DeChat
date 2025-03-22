const express = require('express');
const path = require('path')
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const { Socket } = require('dgram');

const io = new Server(server , {
    maxHttpBufferSize: 5e6,
    pingTimeout: 25000,
    pingInterval: 1000
})

const rooms = {}
const colorPool = {}
const assignedColors = {}
const msg_index = {}
const isBubble = {}
const isReplying = {}
const room_titles = {}
const room_max_connections = {}


// To increase the size to transfer files , easily
app.use(express.json({limit: '50mb'})) 
app.use(express.urlencoded({limit: '50mb' , extended: true}))

app.get('/', (req, res) => {
    return res.sendFile(path.resolve(__dirname, 'public', 'doors.html'));
});

app.get('/index.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use(express.static(path.join(__dirname, 'public')));



function assignColors(colors){
    return Math.floor(Math.random()*colors.length)
}

io.on('connection' , user => {
    io.to(user.id).emit("displayAvailableRooms" , assignedColors , room_titles , room_max_connections)
    
    user.on('joinRoom' , (roomKey , room_title , max_connections) => {
        if(!rooms[roomKey]){
            rooms[roomKey] = {}
            room_titles[roomKey] = room_title
            room_max_connections[roomKey] = max_connections
            colorPool[roomKey] = ['#00AFFF' , '#F5F5F0' , '#EE6666' , '#FFD700' , '#F2E68F' , '#00FFFF' , '#F87AA3' , '#C5F5CB']
            assignedColors[roomKey] = []
            msg_index[roomKey] = 0
            isBubble[roomKey] = false
            isReplying[roomKey] = {}      
        }
        else if(Object.keys(rooms[roomKey]).length >= room_max_connections[roomKey]) {
            io.to(user.id).emit('RoomLimitReached' , 'Cannot Connect  , Room limit reached :(')
            return
        }

        
        user.join(roomKey)

        user.on('get_room_title' , () => {
            io.to(user.id).emit('take_room_title' , room_titles[roomKey])
        })

        io.to(user.id).emit('TakeUserId' , user.id)

        isReplying[roomKey][user.id] = [false , false , '' , '']

        let index = assignColors(colorPool[roomKey])
        
        rooms[roomKey][user.id] = colorPool[roomKey][index]


        if(index === colorPool[roomKey].length - 1){
            assignedColors[roomKey].push(colorPool[roomKey].pop())
        }
        else{
            let temp = colorPool[roomKey][index]
            colorPool[roomKey][index] = colorPool[roomKey][colorPool[roomKey].length - 1]
            colorPool[roomKey][colorPool[roomKey].length - 1] = temp
            assignedColors[roomKey].push(colorPool[roomKey].pop())
        }
        
        console.log(assignedColors)

        io.to(roomKey).emit('addMemberBall' , assignedColors[roomKey])

        console.log(colorPool , colorPool[roomKey].length)
        
        
        console.log('A Dechatter just Slid in.')

        user.on('editMsg' , (msg_index_for_edit , msg) => {
            let userColor = rooms[roomKey][user.id]
            let replying_flag_file = isReplying[roomKey][user.id][0]
            let replying_flag = isReplying[roomKey][user.id][1]
            let rmsg = isReplying[roomKey][user.id][2]
            let rcolor = isReplying[roomKey][user.id][3]
            io.to(roomKey).emit('msgEdited' , { msg , userColor } , user.id , msg_index_for_edit , replying_flag_file , replying_flag , rmsg , rcolor)
        })

        user.on('sendFile' , (file_data , file_type) => {
            let userColor = rooms[roomKey][user.id]
            msg_index[roomKey]++
            io.to(roomKey).emit('receiveFile' , user.id , file_data , file_type , userColor , msg_index[roomKey])
        })

        user.on('typing' , () => {
            let userColor = rooms[roomKey][user.id]
            let activeBubble = isBubble[roomKey]
            io.to(roomKey).emit('addtypingball' , userColor , activeBubble)
            isBubble[roomKey] = true
        })

        user.on('stoppedTyping' , () => {
            let userColor = rooms[roomKey][user.id]
            io.to(roomKey).emit('removetypingBall' , userColor)
        })

        user.on('updateBubbleFlag' , (value) => {
            isBubble[roomKey] = value
        })

        user.on('send_message' , (msg) => {
            let userColor = rooms[roomKey][user.id]
            let file_flag = isReplying[roomKey][user.id][0]
            let flag = isReplying[roomKey][user.id][1]
            let rmsg = isReplying[roomKey][user.id][2]
            let rcolor = isReplying[roomKey][user.id][3]
            console.log('Sender: ' , user.id)
            msg_index[roomKey]++
            io.to(roomKey).emit('message' , { msg , userColor } , user.id , msg_index[roomKey] ,file_flag, flag , rmsg , rcolor)
        })

        user.on('deleteMsg' , (msgToDel) => {
            io.to(roomKey).emit('delfromChatBox' , msgToDel)
        })

        user.on('update_reply_flag' , (file_flag , flag , rmsg , rcolor) => {
            isReplying[roomKey][user.id][0] = file_flag
            isReplying[roomKey][user.id][1] = flag
            isReplying[roomKey][user.id][2] = rmsg
            isReplying[roomKey][user.id][3] = rcolor
            console.log(isReplying[roomKey])
        })

        user.on('disconnect' , () => {

            console.log('User Disconnected.')

            let userColor = rooms[roomKey][user.id]

            io.to(roomKey).emit('userDisconnected')

            io.to(roomKey).emit('removeMemberColorBall' , userColor)
            io.to(roomKey).emit('removetypingBall' , userColor)

            assignedColors[roomKey] = assignedColors[roomKey].filter((assignedColor) => { return assignedColor != userColor })

            console.log('Disconnected: ' , assignedColors[roomKey])

            colorPool[roomKey].push(userColor)

            delete rooms[roomKey][user.id]

            if(Object.keys(rooms[roomKey]).length === 0 || assignedColors[roomKey].length === 0){
                delete colorPool[roomKey]
                delete assignedColors[roomKey]
                delete rooms[roomKey]
                delete isBubble[roomKey]
                delete msg_index[roomKey]
                delete isReplying[roomKey]
                delete room_titles[roomKey]
                delete room_max_connections[roomKey]
                io.emit('destroyRoomBlock' , roomKey)
            }
        })
    })
})



const PORT = process.env.PORT || 3000;
server.listen(PORT , () => {
    console.log(`Server started at PORT: ${PORT}`);
});
