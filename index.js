const express = require('express');
const path = require('path');
const app = express();
const mongoose = require('mongoose');
const http = require('http');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const server = http.createServer(app);
const { Server } = require("socket.io");
const zlib = require('zlib');
const { Socket } = require('dgram');
require('dotenv').config();

const io = new Server(server , {
    maxHttpBufferSize: 5e6,
    pingTimeout: 25000,
    pingInterval: 1000
})

const DB_URL = process.env.DB_URL
const dbKey = process.env.DB_KEY;
const rooms = {}
const colorPool = {}
const assignedColors = {}
const msg_index = {} // maintians the index of the latest messages in a room
const isBubble = {} // maintains the state of the active bubble per room Eg: stores the roomkey as key and boolean value as value.
const isReplying = {} // maintains the replying state of user per room i.e. stores the boolean values of whether the user is replying to a particular message or not and if the user is replying to a file or not.
const room_titles = {} 
const room_max_connections = {}
// IS FILE FLAGS
const YES_FILE = true
const NO_FILE = false
// IS REPLYING TO A MESSAGE FLAG
const FLAG = true

mongoose.connect(DB_URL);

const UserSchema = new mongoose.Schema(
    {
        username: String,
        email: String,
        password: String,
        RoomOnlineData: [ // maintains the UP time of the user in a room along with the date.
            {
                Date: String, // dd-mm-yyyy
                joinTime: Object, // Join time : Leave time (Key value Pairs).
            }
        ]

    }
)

const User = mongoose.model('users' , UserSchema)

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


app.get('/login.html' , (req , res) => {
    return res.sendFile(path.resolve(__dirname, 'public', 'login.html'))
})

app.get('/signup.html', (req, res) => {
    return res.sendFile(path.resolve(__dirname, 'public', 'signup.html'));
});

app.post('/login' , async (req , res) => {
    const {email , password} = req.body;
    const user = await User.findOne({email});
    if(!user){
        return res.json({message: 'Invalid email or password.'});
    }
    const isMatch = await bcrypt.compare(password , user.password);

    if(!isMatch){
        return res.json({message: 'Invalid Password.'});
    }

    const token = jwt.sign({id: user._id} , dbKey , {expiresIn: "31d"});
    res.json({token});
})

app.post('/signup' , async (req , res) => {
    const {username , email , password} = req.body;
    const userExists = await User.findOne({email});
    if(userExists){
        return res.json({message: 'User already logged in.'});
    }
    const saltRounds = 10;
    const hashed = await bcrypt.hash(password , saltRounds);
    const newUser = new User({username , email , password: hashed});
    await newUser.save();

    res.status(200).json({
        success: true,
        message: 'Successfully Signed In 🥂'
    });
})

// Randomly assigns the color from the color pool
function assignColors(colors){
    return Math.floor(Math.random()*colors.length)
}

// consrtucts a message object including the message information to send to the room and the user.
function constructMsgObject(senderId , msg , msg_i , userColor , file_flag , flag , rmsg , rcolor){
    let msg_object = {
        sender: senderId,
        msg: msg,
        msg_index: msg_i,
        userColor : userColor,
        file_flag: file_flag,
        flag : flag,
        rmsg : rmsg,
        rcolor: rcolor
    }
    return msg_object;
}

// constructs a file object with necessary file information to pass to the room
function senderInfo(senderId , userColor , msg_index){
    let file_object = {
        sender: senderId,
        userColor : userColor,
        msg_index: msg_index
    }
    return file_object
}

// Handles the disconnection when a user leaves a room
function handleDisconnections(userId , userColor , roomKey){
    io.to(roomKey).emit('userDisconnected' , roomKey , assignedColors[roomKey] , room_max_connections[roomKey] , room_titles[roomKey])
    io.to(roomKey).emit('removeMemberColorBall' , userColor)
    io.to(roomKey).emit('removetypingBall' , userColor)

    assignedColors[roomKey] = assignedColors[roomKey].filter((assignedColor) => { return assignedColor != userColor })
    colorPool[roomKey].push(userColor)

    delete rooms[roomKey][userId]
}

// Destroys the empty rooms.
function destroyEmptyRoom(roomKey){
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

function createAndInitializeRoom(roomKey , room_title , max_connections){
    rooms[roomKey] = {}
    room_titles[roomKey] = room_title
    room_max_connections[roomKey] = max_connections
    colorPool[roomKey] = ['#00AFFF' , '#F5F5F0' , '#EE6666' , '#FFD700' , '#F2E68F' , '#00FFFF' , '#F87AA3' , '#C5F5CB']
    assignedColors[roomKey] = []
    msg_index[roomKey] = 0
    isBubble[roomKey] = false
    isReplying[roomKey] = {}   
}

function reachedMaxConnections(roomKey){
    return Object.keys(rooms[roomKey]).length >= room_max_connections[roomKey]
}

// Heart beat connections from the backend to keep the connection alive with the frontend and to prevent the render free tier server from spinning down
setInterval(() => {
    io.emit('Sustain_connection')
    console.log('Revive call sent.')
} , 45000)


// Handles the new connections and disconnections.
io.on('connection' , user => {

    

    io.to(user.id).emit("displayAvailableRooms" , assignedColors , room_titles , room_max_connections)
    
    user.on('joinRoom' , (roomKey , room_title , max_connections) => {
        if(!rooms[roomKey]){
            // information related to the rooms can be stored in one rooms object , no need to make all these different objects , makes the code bloated.
            createAndInitializeRoom(roomKey , room_title , max_connections)
        }
        else if(reachedMaxConnections(roomKey)) {
            io.to(user.id).emit('RoomLimitReached' , 'Cannot Connect  , Room limit reached :(')
            return
        }

        
        user.join(roomKey)

        user.on('get_room_title' , () => {
            io.to(user.id).emit('take_room_title' , room_titles[roomKey])
        })

        io.to(user.id).emit('TakeUserId' , user.id)

        user.on("upload-chunk", (chunk) => {
            io.to(roomKey).emit("image-chunk", chunk);
        });

        user.on("image-end", () => {
            let userColor = rooms[roomKey][user.id]
            let msg_i = msg_index[roomKey]
            let sender_obj = senderInfo(user.id , userColor , msg_i)
            msg_index[roomKey]++
            io.to(roomKey).emit('recieve_file' , sender_obj)
        });

        isReplying[roomKey][user.id] = [NO_FILE , !FLAG , '' ,-1 , ''] // initialising the isReplying object for the user in the room.

        let color = assignColors(colorPool[roomKey])
        
        rooms[roomKey][user.id] = colorPool[roomKey][color]
        assignedColors[roomKey].push(colorPool[roomKey][color])
        colorPool[roomKey].splice(color , 1)
        
        console.log('Assigned Colors: ' , assignedColors)

        io.to(roomKey).emit('addMemberBall' , assignedColors[roomKey])

        console.log('Color pool: ' , colorPool , colorPool[roomKey].length)
        
        user.on('editMsg' , (msg_index_for_edit , msg) => {
            let userColor = rooms[roomKey][user.id]
            let replying_flag_file = isReplying[roomKey][user.id][0]
            let replying_flag = isReplying[roomKey][user.id][1]
            let rmsg = isReplying[roomKey][user.id][2]
            let file_msg_index = isReplying[roomKey][user.id][4]
            let rcolor = isReplying[roomKey][user.id][3]
            let msg_object = constructMsgObject(user.id , msg , msg_index_for_edit , userColor , replying_flag_file , replying_flag , rmsg ,file_msg_index, rcolor)
            io.to(roomKey).emit('msgEdited' , msg_object)
        })

        // user.on('sendFile' , (file_data , file_type) => {
        //     let userColor = rooms[roomKey][user.id]
        //     let msg_i = msg_index[roomKey]
        //     let file_object = senderInfo(user.id , userColor , msg_i , file_data , file_type)
        //     msg_index[roomKey]++
        //     io.to(roomKey).emit('receiveFile' , file_object)
        // })

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
            let file_msg_index = isReplying[roomKey][user.id][2]
            let rcolor = isReplying[roomKey][user.id][3]
            let msg_i = msg_index[roomKey]
            msg_object = constructMsgObject(user.id , msg , msg_i , userColor , file_flag , flag , file_msg_index , rcolor)
            msg_index[roomKey]++
            io.to(roomKey).emit('message' , msg_object)
        })

        user.on('deleteMsg' , (msgToDel) => {
            io.to(roomKey).emit('delfromChatBox' , msgToDel)
        })

        user.on('update_reply_flag' , (file_flag , flag , rmsg ,file_msg_index, rcolor) => {
            isReplying[roomKey][user.id][0] = file_flag
            isReplying[roomKey][user.id][1] = flag
            isReplying[roomKey][user.id][2] = rmsg
            isReplying[roomKey][user.id][3] = rcolor
            isReplying[roomKey][user.id][4] = file_msg_index
            console.log('is Replying: ' , isReplying[roomKey])
        })

        user.on('disconnect' , () => {
            let userColor = rooms[roomKey][user.id]
            handleDisconnections(user.id , userColor , roomKey)

            if(Object.keys(rooms[roomKey]).length === 0 || assignedColors[roomKey].length === 0){
                destroyEmptyRoom(roomKey)
            }
        })
    })
})

const PORT = process.env.PORT || 3000;
server.listen(PORT , () => {
    console.log(`Server started at PORT: ${PORT}`);
});
